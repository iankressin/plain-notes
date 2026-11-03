import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as store from '../mcp-server/src/notes-store';

type Collection = {
  root: string; writeDelay: number; failMove: boolean; failWrite: boolean; failList: boolean; quit: boolean;
  pauseCreation: boolean; resumeCreation?: () => void;
  pauseRead: string; resumeRead?: () => void;
};
const test = base.extend<{ collection: Collection }>({
  collection: async ({ page }, use) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plain-notes-ui-'));
    const collection: Collection = { root, writeDelay: 0, failMove: false, failWrite: false, failList: false, quit: false, pauseCreation: false, pauseRead: '' };
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !collection.failWrite && !collection.failList) pageErrors.push(message.text());
    });
    await fs.writeFile(path.join(root, 'root.md'), '# Root note\n\nOriginal body\n');
    const info = (note: store.NoteMeta) => ({ ...note, path: path.join(root, `${note.id}.md`) });
    const idOf = (file: string) => path.relative(root, file).split(path.sep).join('/').replace(/\.md$/, '');
    await page.exposeFunction('notesInvoke', async (command: string, args: Record<string, any> = {}) => {
      switch (command) {
        case 'list_notes':
          if (collection.failList) throw new Error('Test listing failure');
          return (await store.listNotes(root)).map(info);
        case 'list_folders': return store.listFolders(root);
        case 'read_note':
          if (idOf(args.path) === collection.pauseRead) await new Promise<void>((resolve) => { collection.resumeRead = resolve; });
          return (await store.readNote(root, idOf(args.path))).content;
        case 'write_note':
          if (collection.writeDelay) await new Promise((resolve) => setTimeout(resolve, collection.writeDelay));
          if (collection.failWrite) throw new Error('Test write failure');
          return store.editNote(root, { id: idOf(args.path), mode: 'replace', content: args.content });
        case 'create_note':
          if (collection.pauseCreation) await new Promise<void>((resolve) => { collection.resumeCreation = resolve; });
          return info(await store.createNote(root, args));
        case 'create_folder': return store.createFolder(root, args.parent, args.name);
        case 'move_note':
          if (collection.failMove) throw new Error('Test move failure');
          return info(await store.moveNote(root, idOf(args.path), args.folder));
        case 'delete_note': return store.deleteNote(root, idOf(args.path));
        case 'quit_app': collection.quit = true; return;
        default:
          if (command.startsWith('plugin:')) return null;
          throw new Error(`Unexpected command: ${command}`);
      }
    });
    await page.addInitScript(() => {
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<string, number[]>();
      let nextId = 1;
      const target = window as any;
      target.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback: (value: unknown) => void) {
          const id = nextId++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        async invoke(command: string, args: Record<string, any> = {}) {
          if (command === 'plugin:event|listen') {
            listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
            return args.handler;
          }
          return target.notesInvoke(command, args);
        },
      };
      target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      target.emitNotesChanged = (paths: string[]) => {
        for (const id of listeners.get('notes-changed') ?? []) callbacks.get(id)?.({ payload: { paths } });
      };
    });
    await page.goto('/');
    await expect(page.locator('.tiptap-editor')).toContainText('Root note');
    // Stand in for the native window material behind the transparent webview.
    await page.evaluate(() => {
      document.documentElement.style.backgroundColor = matchMedia('(prefers-color-scheme: dark)').matches ? '#1c1c1e' : '#fff';
    });
    try { await use(collection); expect(pageErrors).toEqual([]); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  },
});

async function browse(page: Page) {
  await page.getByRole('button', { name: 'Browse notes', exact: true }).click();
}

async function newFolder(page: Page, name: string) {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('creates nested folders and notes with breadcrumbs', async ({ page, collection }) => {
  await browse(page);
  await newFolder(page, 'Work');
  await page.getByRole('button', { name: 'Open folder Work', exact: true }).click();
  await newFolder(page, 'Project A');
  await page.getByRole('button', { name: 'Open folder Project A', exact: true }).click();
  await expect(page.getByText('This folder is empty.')).toBeVisible();
  await page.getByRole('button', { name: 'New note', exact: true }).click();
  await expect(page.locator('.tiptap-editor')).toContainText('New Note');
  expect((await store.listNotes(collection.root)).some((note) => note.folder === 'Work/Project A')).toBe(true);
  await browse(page);
  await page.getByRole('navigation', { name: 'Folder location' }).getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Root note', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open folder Work', exact: true })).toBeVisible();
});

test('saves pending edits before moving and keeps editing at the new path', async ({ page, collection }) => {
  await store.createFolder(collection.root, '', 'Work');
  collection.writeDelay = 100;
  await page.locator('.tiptap-editor .ProseMirror').fill('Latest edits');
  await page.getByRole('button', { name: 'Move note', exact: true }).click();
  await page.getByLabel('Destination folder').selectOption('Work');
  await page.getByRole('button', { name: 'Move note', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await fs.readFile(path.join(collection.root, 'Work/root.md'), 'utf8')).toContain('Latest edits');
  await expect.poll(async () => (await store.listNotes(collection.root)).map((note) => note.id)).toEqual(['Work/root']);
  await page.locator('.tiptap-editor .ProseMirror').fill('Edited after moving');
  await expect.poll(() => fs.readFile(path.join(collection.root, 'Work/root.md'), 'utf8')).toContain('Edited after moving');
  expect(await fs.stat(path.join(collection.root, 'root.md')).catch(() => null)).toBeNull();
  await page.getByRole('button', { name: 'Move note', exact: true }).click();
  await page.getByLabel('Destination folder').selectOption('');
  await page.getByRole('button', { name: 'Move note', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await fs.readFile(path.join(collection.root, 'root.md'), 'utf8')).toContain('Edited after moving');
  expect(await fs.stat(path.join(collection.root, 'Work/root.md')).catch(() => null)).toBeNull();
});

test('move failures retain the original note and show an error', async ({ page, collection }) => {
  await store.createFolder(collection.root, '', 'Work');
  collection.failMove = true;
  await page.getByRole('button', { name: 'Move note', exact: true }).click();
  await page.getByLabel('Destination folder').selectOption('Work');
  await page.getByRole('button', { name: 'Move note', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('Test move failure');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.tiptap-editor .ProseMirror').fill('Still editable');
  await expect.poll(() => fs.readFile(path.join(collection.root, 'root.md'), 'utf8')).toContain('Still editable');
});

test('failed saves prevent moving unsaved text', async ({ page, collection }) => {
  await store.createFolder(collection.root, '', 'Work');
  collection.failWrite = true;
  await page.locator('.tiptap-editor .ProseMirror').fill('Unsaved edits');
  await page.getByRole('button', { name: 'Move note', exact: true }).click();
  await page.getByLabel('Destination folder').selectOption('Work');
  await page.getByRole('button', { name: 'Move note', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('save');
  expect(await fs.stat(path.join(collection.root, 'Work/root.md')).catch(() => null)).toBeNull();
  expect(await fs.readFile(path.join(collection.root, 'root.md'), 'utf8')).toContain('Original body');
});

test('search finds nested notes by title and folder', async ({ page, collection }) => {
  await store.createFolder(collection.root, '', 'Research');
  await store.createNote(collection.root, { folder: 'Research', title: 'Domain knowledge' });
  await browse(page);
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search notes or run a command…').fill('Research');
  await expect(page.getByRole('option').filter({ hasText: 'Domain knowledge' })).toBeVisible();
  await page.getByRole('option').filter({ hasText: 'Domain knowledge' }).click();
  await expect(page.locator('.tiptap-editor')).toContainText('Domain knowledge');
});

test('folder dialogs support keyboard cancellation and validation', async ({ page, collection }) => {
  await browse(page);
  await newFolder(page, 'Work');
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(page.getByLabel('Folder name', { exact: true })).toBeFocused();
  await page.getByLabel('Folder name', { exact: true }).fill('Work');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(collection.quit).toBe(false);
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toBeFocused();
});

test('external folders refresh and long names fit the window', async ({ page, collection }, testInfo) => {
  await browse(page);
  const name = 'A very long folder name with room for multiple project domains';
  await store.createFolder(collection.root, '', name);
  await page.evaluate(() => (window as any).emitNotesChanged([]));
  await expect(page.getByRole('button', { name: `Open folder ${name}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open folder ${name}`, exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('folder-browser.png') });
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('dialog')!.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('folder-dialog.png') });
});

test('edits made while creating a note are saved before switching', async ({ page, collection }) => {
  collection.pauseCreation = true;
  collection.writeDelay = 100;
  await page.keyboard.press('Control+n');
  await expect.poll(() => !!collection.resumeCreation).toBe(true);
  await page.locator('.tiptap-editor .ProseMirror').fill('Typed while creating');
  collection.resumeCreation!();
  await expect(page.locator('.tiptap-editor')).toContainText('New Note');
  expect(await fs.readFile(path.join(collection.root, 'root.md'), 'utf8')).toContain('Typed while creating');
  await page.locator('.tiptap-editor .ProseMirror').fill('Saved in the new note');
  await expect.poll(async () => {
    const notes = await store.listNotes(collection.root);
    return notes.some((note) => note.id !== 'root' && note.title === 'Saved in the new note');
  }).toBe(true);
});

test('moving is blocked until a pending note load finishes', async ({ page, collection }) => {
  await fs.writeFile(path.join(collection.root, 'second.md'), '# Second note\n\nSeparate body\n');
  collection.pauseRead = 'second';
  await browse(page);
  await page.getByRole('button', { name: 'Back to note', exact: true }).click();
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search notes or run a command…').fill('Second note');
  await page.getByRole('option').filter({ hasText: 'Second note' }).first().click();
  await expect.poll(() => !!collection.resumeRead).toBe(true);
  await expect(page.getByRole('button', { name: 'Move note', exact: true })).toBeDisabled();
  collection.resumeRead!();
  await expect(page.locator('.tiptap-editor')).toContainText('Second note');
  await page.locator('.tiptap-editor .ProseMirror').fill('Second note edited');
  await expect.poll(() => fs.readFile(path.join(collection.root, 'second.md'), 'utf8')).toContain('Second note edited');
  expect(await fs.readFile(path.join(collection.root, 'root.md'), 'utf8')).toContain('Original body');
});

test('folder listing errors can be retried without losing the open note', async ({ page, collection }) => {
  collection.failList = true;
  await browse(page);
  await expect(page.getByRole('alert')).toContainText('Could not load notes and folders');
  collection.failList = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Root note', exact: true }).click();
  await expect(page.locator('.tiptap-editor')).toContainText('Original body');
});

test('an externally moved note can be reopened without recreating its old file', async ({ page, collection }) => {
  await store.createFolder(collection.root, '', 'Work');
  await store.moveNote(collection.root, 'root', 'Work');
  await page.evaluate((oldPath) => (window as any).emitNotesChanged([oldPath]), path.join(collection.root, 'root.md'));
  await expect(page.getByText('This note was moved or removed. You can still copy its text.')).toBeVisible();
  await expect(page.locator('.ProseMirror')).not.toBeEditable();
  await browse(page);
  await page.getByRole('button', { name: 'Open folder Work', exact: true }).click();
  await page.getByRole('button', { name: 'Root note', exact: true }).click();
  await expect(page.locator('.ProseMirror')).toBeEditable();
  await page.locator('.ProseMirror').fill('Edited in the new folder');
  await expect.poll(() => fs.readFile(path.join(collection.root, 'Work/root.md'), 'utf8')).toContain('Edited in the new folder');
  expect(await fs.stat(path.join(collection.root, 'root.md')).catch(() => null)).toBeNull();
});

test('moving an untouched note preserves its exact markdown', async ({ page, collection }) => {
  const original = '# Root note\n\nOriginal body\n';
  expect(await fs.readFile(path.join(collection.root, 'root.md'), 'utf8')).toBe(original);
  await store.createFolder(collection.root, '', 'Work');
  await page.getByRole('button', { name: 'Move note', exact: true }).click();
  await page.getByLabel('Destination folder').selectOption('Work');
  await page.getByRole('button', { name: 'Move note', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await fs.readFile(path.join(collection.root, 'Work/root.md'), 'utf8')).toBe(original);
});
