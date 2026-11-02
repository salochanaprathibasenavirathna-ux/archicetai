const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createApp } = require('../server');

test('account registration requires a strong password and supports authenticated sessions', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'architectai-test-'));
  const legacyChatId = 'legacy-chat';
  fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({
    [legacyChatId]: { id: legacyChatId, title: 'Old chat', updated: Date.now(), messages: [] }
  }));
  const previousDataDir = process.env.ARCHITECTAI_DATA;
  process.env.ARCHITECTAI_DATA = dataDir;

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const postJson = (route, body, cookie) => fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: JSON.stringify(body)
  });

  try {
    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /minlength="12" maxlength="128"/);

    const initialStatus = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(initialStatus.status, 200);
    assert.deepEqual(await initialStatus.json(), {
      loggedIn: false,
      name: null,
      hasAccounts: false,
      hasKey: false
    });

    const crossOrigin = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: 'http://example.invalid',
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(crossOrigin.status, 403);

    const protectedChats = await fetch(`${baseUrl}/api/chats`);
    assert.equal(protectedChats.status, 401);

    const shortPassword = await postJson('/api/auth/register', { name: 'Test User', pin: 'short' });
    assert.equal(shortPassword.status, 400);

    const longPassword = await postJson('/api/auth/register', { name: 'Test User', pin: 'x'.repeat(129) });
    assert.equal(longPassword.status, 400);

    const password = 'correct-horse-battery-staple';
    const registration = await postJson('/api/auth/register', { name: 'Test User', pin: password });
    assert.equal(registration.status, 200);
    assert.deepEqual(await registration.json(), { ok: true, name: 'Test User' });

    const setCookie = registration.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';', 1)[0];

    const authenticatedStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.equal((await authenticatedStatus.json()).loggedIn, true);

    const authenticatedChats = await fetch(`${baseUrl}/api/chats`, { headers: { Cookie: cookie } });
    assert.equal(authenticatedChats.status, 200);
    assert.deepEqual((await authenticatedChats.json()).map(chat => chat.id), [legacyChatId]);

    const apiKey = 'fake-key-for-password-change-test-only';
    const saveKey = await postJson('/api/auth/apikey', { apiKey }, cookie);
    assert.equal(saveKey.status, 200);

    const weakNewPassword = await postJson('/api/auth/password', {
      currentPassword: password,
      newPassword: 'too-short'
    }, cookie);
    assert.equal(weakNewPassword.status, 400);

    const wrongCurrentPassword = await postJson('/api/auth/password', {
      currentPassword: 'incorrect-password',
      newPassword: 'another-correct-password'
    }, cookie);
    assert.equal(wrongCurrentPassword.status, 400);

    const nextPassword = 'another-correct-password';
    const changePassword = await postJson('/api/auth/password', {
      currentPassword: password,
      newPassword: nextPassword
    }, cookie);
    assert.equal(changePassword.status, 200);

    const changedStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.equal((await changedStatus.json()).hasKey, true);
    const changedChats = await fetch(`${baseUrl}/api/chats`, { headers: { Cookie: cookie } });
    assert.deepEqual((await changedChats.json()).map(chat => chat.id), [legacyChatId]);

    const logout = await postJson('/api/auth/logout', {}, cookie);
    assert.equal(logout.status, 200);
    const loggedOutStatus = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.equal((await loggedOutStatus.json()).loggedIn, false);

    const wrongPassword = await postJson('/api/auth/login', { name: 'Test User', pin: 'not-the-password' });
    assert.equal(wrongPassword.status, 400);

    const oldPassword = await postJson('/api/auth/login', { name: 'Test User', pin: password });
    assert.equal(oldPassword.status, 400);

    const login = await postJson('/api/auth/login', { name: 'Test User', pin: nextPassword });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { ok: true, name: 'Test User' });
    const newCookie = login.headers.get('set-cookie').split(';', 1)[0];
    const statusAfterLogin = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: newCookie } });
    assert.equal((await statusAfterLogin.json()).hasKey, true);

    await postJson('/api/auth/logout', {}, newCookie);
    const oldPasswordForLegacyAccount = '1234';
    const legacySalt = crypto.randomBytes(16).toString('hex');
    const legacyKey = crypto.scryptSync(oldPasswordForLegacyAccount, Buffer.from(legacySalt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
    const usersFile = path.join(dataDir, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const legacyUserId = 'legacy-user';
    users.users.push({
      id: legacyUserId,
      name: 'Legacy User',
      salt: legacySalt,
      verifier: legacyKey.subarray(0, 32).toString('hex'),
      owner: false,
      created: Date.now()
    });
    fs.writeFileSync(usersFile, JSON.stringify(users));
    const legacyUserChatId = 'legacy-user-chat';
    fs.writeFileSync(path.join(dataDir, `chats-${legacyUserId}.json`), JSON.stringify({
      [legacyUserChatId]: { id: legacyUserChatId, title: 'Private old chat', updated: Date.now(), messages: [] }
    }));

    const legacyLogin = await postJson('/api/auth/login', { name: 'Legacy User', pin: oldPasswordForLegacyAccount });
    assert.equal(legacyLogin.status, 200);
    const legacyCookie = legacyLogin.headers.get('set-cookie').split(';', 1)[0];
    const migratePassword = await postJson('/api/auth/password', {
      currentPassword: oldPasswordForLegacyAccount,
      newPassword: 'a-stronger-legacy-password'
    }, legacyCookie);
    assert.equal(migratePassword.status, 200);

    const legacyChats = await fetch(`${baseUrl}/api/chats`, { headers: { Cookie: legacyCookie } });
    assert.deepEqual((await legacyChats.json()).map(chat => chat.id), [legacyUserChatId]);
    const encryptedChatFile = JSON.parse(fs.readFileSync(path.join(dataDir, `chats-${legacyUserId}.json`), 'utf8'));
    assert.ok(encryptedChatFile.iv && encryptedChatFile.tag && encryptedChatFile.data);

    await postJson('/api/auth/logout', {}, legacyCookie);
    const legacyOldPasswordLogin = await postJson('/api/auth/login', { name: 'Legacy User', pin: oldPasswordForLegacyAccount });
    assert.equal(legacyOldPasswordLogin.status, 400);
    const legacyNewPasswordLogin = await postJson('/api/auth/login', { name: 'Legacy User', pin: 'a-stronger-legacy-password' });
    assert.equal(legacyNewPasswordLogin.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousDataDir === undefined) delete process.env.ARCHITECTAI_DATA;
    else process.env.ARCHITECTAI_DATA = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
