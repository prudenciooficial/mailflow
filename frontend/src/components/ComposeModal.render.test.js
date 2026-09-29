// Render test for ComposeModal's draft autosave (#413).
//
// The autosave rules are unit-tested in utils/draftAutosave.test.js, but whether a draft counts
// as dirty depends on the live TipTap editor, which rewrites the HTML it loads. That only shows
// up with the real component mounted, so this mounts it the same way the other render tests do.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

// A draft as Gmail saves it. TipTap loads this as <p> paragraphs, so its getHTML() never
// matches the stored string even when nobody has touched it.
const GMAIL_DRAFT = '<div dir="ltr">Hi Bob,<div><br></div><div>The contract is attached.</div></div>';

const saved = [];

// Autosave also runs when the tab is hidden, without waiting for the idle timer, which makes
// it the deterministic way to ask the composer "would you save now?".
async function hideTab() {
  visibility = 'hidden';
  await React.act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
  await React.act(async () => {});
  visibility = 'visible';
}

// Opens a draft the way MessageList does for a click in the Drafts folder. Returns an unmount.
async function openDraft({ plaintextEmail, body }) {
  saved.length = 0;
  useStore.setState({ plaintextEmail });
  useStore.getState().openCompose({
    accountId: 'acct',
    draftUid: 7,
    draftFolder: 'Drafts',
    to: ['Bob <bob@example.invalid>'],
    cc: [],
    subject: 'Contract',
    body,
    bodyIsHtml: !plaintextEmail,
  });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  // immediatelyRender: false creates the editor in an effect after the first commit.
  await React.act(async () => {});
  return () => React.act(async () => root.unmount());
}

before(() => {
  api.saveDraft = async (payload) => { saved.push(payload); return { uid: 8, folder: 'Drafts' }; };
  useStore.setState({
    user: { id: 'u1' },
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
});

describe('reopening a draft saved by another client', () => {
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT }); });
  after(() => close());

  test('mounts the draft into the editor', () => {
    const editor = document.querySelector('.ProseMirror')?.editor;
    assert.ok(editor, 'the rich-text editor mounted');
    assert.match(editor.getHTML(), /The contract is attached\./);
    assert.notEqual(editor.getHTML(), GMAIL_DRAFT, 'precondition: TipTap rewrote the stored HTML');
  });

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });

  test('still autosaves once the body is edited, replacing the same draft', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'a real edit is saved');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.match(saved[0].body, /Thanks\./);
  });
});

describe('reopening a draft in plain-text mode', () => {
  // The editor still mounts in plain-text mode, but the dirty check compares the textarea, so
  // its baseline has to stay the raw body.
  let close;
  before(async () => { close = await openDraft({ plaintextEmail: true, body: 'Hi Bob,\n\nThe contract is attached.' }); });
  after(() => close());

  test('does not autosave a draft that was only opened', async () => {
    await hideTab();
    assert.equal(saved.length, 0, 'an untouched draft must not be rewritten');
  });
});

describe('switching From on a reopened draft', () => {
  // The old copy stays in the account it was saved to. The backend used to delete its uid in
  // whichever account From named, which expunged an unrelated message there when both
  // accounts have a Drafts folder.
  let close;
  before(async () => {
    useStore.setState({
      accounts: [
        { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' },
        { id: 'other', enabled: true, email_address: 'other@example.invalid', name: 'Other', color: '#000' },
      ],
    });
    close = await openDraft({ plaintextEmail: false, body: GMAIL_DRAFT });
  });
  after(() => close());

  test('names the account that holds the copy being replaced', async () => {
    const from = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'account:other'));
    await React.act(async () => {
      from.value = 'account:other';
      from.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Thanks.'); });
    await hideTab();
    assert.equal(saved.length, 1, 'the edit is saved');
    assert.equal(saved[0].accountId, 'other', 'the new copy goes to the account From names');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].existingFolder, 'Drafts');
    assert.equal(saved[0].existingAccountId, 'acct', 'the old copy is deleted from its own account');
  });

  test('the next save replaces the new copy in the account it was saved to', async () => {
    saved.length = 0;
    const editor = document.querySelector('.ProseMirror').editor;
    await React.act(async () => { editor.commands.insertContent(' Bye.'); });
    await hideTab();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].existingUid, 8);
    assert.equal(saved[0].existingAccountId, 'other');
  });
});

describe('undo send', () => {
  // Mounted the way MailApp mounts it, so closing the composer unmounts it and reopening it
  // mounts a fresh one from the store's composeData.
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  const posted = [];
  const deleted = [];
  const cancels = [];
  let unmount;
  before(async () => {
    useStore.setState({
      plaintextEmail: false,
      notifications: [],
      accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
    });
    api.post = async (path, payload) => {
      posted.push({ path, payload });
      return { ok: true, pending: true, pendingId: 'p1', sendAt: new Date(Date.now() + 10_000).toISOString() };
    };
    api.deleteDraft = async (...args) => { deleted.push(args); return { ok: true }; };
    api.cancelSend = async (id) => { cancels.push(id); return { cancelled: true }; };
    api.getSendStatus = async () => ({ status: 'pending' });
    useStore.getState().openCompose({
      accountId: 'acct',
      draftUid: 7,
      draftFolder: 'Drafts',
      to: ['Bob <bob@example.invalid>'],
      cc: [],
      subject: 'Contract',
      body: '<p>Here it is.</p>',
      attachments: [{ name: 'contract.pdf', size: 3, type: 'application/pdf', data: 'QUJD' }],
      priority: 'high',
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('Send hands the message to the server with an undo window and closes the composer', async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(posted.length, 1);
    const { payload } = posted[0];
    assert.equal(payload.undoSeconds, 10);
    assert.deepEqual(payload.draft, { uid: 7, folder: 'Drafts', accountId: 'acct' });
    assert.equal(payload.attachments[0].filename, 'contract.pdf');
    assert.equal(payload.priority, 'high');
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deleted, [], 'the draft stays until the server has delivered the message');
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    assert.equal(bar.title, 'compose.sending');
    assert.ok(bar.undoMs > 9000 && bar.undoMs <= 10_000, `undo window ${bar.undoMs} ms`);
  });

  test('Undo gives the message back as it was sent, attachments included', async () => {
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { await bar.onUndo(); });
    await React.act(async () => {});
    assert.deepEqual(cancels, ['p1']);
    assert.equal(useStore.getState().composing, true);
    const data = useStore.getState().composeData;
    assert.equal(data.subject, 'Contract');
    assert.deepEqual(data.to, ['Bob <bob@example.invalid>']);
    assert.equal(data.priority, 'high');
    assert.equal(data.draftUid, 7);
    assert.match(document.body.textContent, /contract\.pdf/, 'the attachment is back in the composer');
    assert.match(document.querySelector('.ProseMirror').editor.getHTML(), /Here it is\./);
  });

  test('the reopened message counts as unsaved, so its draft is brought up to date', async () => {
    saved.length = 0;
    await hideTab();
    assert.equal(saved.length, 1, 'saved although nothing was typed since it reopened');
    assert.equal(saved[0].existingUid, 7);
    assert.equal(saved[0].subject, 'Contract');
  });

  test('a server without undo send delivers at once, and the draft is deleted from here', async () => {
    posted.length = 0;
    api.post = async (path, payload) => { posted.push({ path, payload }); return { ok: true }; };
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    assert.equal(useStore.getState().composing, false);
    assert.deepEqual(deleted, [['acct', 8, 'Drafts']], 'the copy saved after the undo');
    assert.equal(useStore.getState().notifications[0].title, 'compose.sent.title');
  });
});

describe('undo send, message without attachments', () => {
  // With nothing to set it apart from its draft, only being a reopened message keeps it from
  // looking saved: closing it would then drop whatever was typed after the last autosave.
  const Host = () => (useStore(s => s.composing) ? React.createElement(ComposeModal) : null);
  let unmount;
  before(async () => {
    useStore.setState({ plaintextEmail: false, notifications: [] });
    api.post = async () => ({ ok: true, pending: true, pendingId: 'p2', sendAt: new Date(Date.now() + 10_000).toISOString() });
    api.cancelSend = async () => ({ cancelled: true });
    useStore.getState().openCompose({
      accountId: 'acct', draftUid: 9, draftFolder: 'Drafts',
      to: ['Bob <bob@example.invalid>'], cc: [], subject: 'Plan', body: '<p>Typed after the last autosave.</p>',
    });
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(Host)); });
    await React.act(async () => {});
    unmount = () => React.act(async () => root.unmount());
  });
  after(() => unmount());

  test('the reopened message still counts as unsaved', async () => {
    const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'compose.send');
    await React.act(async () => { send.click(); });
    await React.act(async () => {});
    const bar = useStore.getState().notifications.find(n => n.onUndo);
    await React.act(async () => { await bar.onUndo(); });
    await React.act(async () => {});
    saved.length = 0;
    await hideTab();
    assert.equal(saved.length, 1, 'saved although nothing was typed since it reopened');
    assert.equal(saved[0].existingUid, 9);
    assert.match(saved[0].body, /Typed after the last autosave\./);
  });
});
