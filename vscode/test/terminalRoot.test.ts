// The same cases as the PyCharm Git extension (extensions repo, src/test/unit/terminalRoot.test.ts); keep them equal.
import * as assert from "node:assert";
import { describe, it } from "vitest";
import { terminalRoot } from "../src/terminalRoot";

const win = { platform: 'win32' as const, home: 'C:\\Users\\Dev' };
const posix = { platform: 'linux' as const, home: '/home/dev' };

describe('Terminal: a new terminal in a multi-root workspace opens in the common root (PyCharm: the project root)', () => {
  it('a worktree set: three worktrees next to each other open in the folder that holds them', () => {
    const folders = ['C:\\Users\\Dev\\sets\\story-42\\orders-api', 'C:\\Users\\Dev\\sets\\story-42\\orders-ui', 'c:\\users\\dev\\sets\\story-42\\shared-lib'];
    assert.strictEqual(terminalRoot({ ...win, folders }), 'C:\\Users\\Dev\\sets\\story-42');
  });

  it('the folder of a .code-workspace file, when every folder lies below it', () => {
    const folders = ['C:\\work\\shop\\repos\\api', 'C:\\work\\shop\\repos\\web\\app'];
    assert.strictEqual(terminalRoot({ ...win, folders, workspaceFile: 'C:\\work\\shop\\shop.code-workspace' }), 'C:\\work\\shop');
  });

  it('a .code-workspace file elsewhere is ignored: the common parent of the folders wins', () => {
    const folders = ['C:\\work\\shop\\api', 'C:\\work\\shop\\web'];
    assert.strictEqual(terminalRoot({ ...win, folders, workspaceFile: 'C:\\Users\\Dev\\workspaces\\shop.code-workspace' }), 'C:\\work\\shop');
  });

  it('different drives: the folder of the active file, else the first folder', () => {
    const folders = ['C:\\work\\api', 'D:\\data\\web'];
    assert.strictEqual(terminalRoot({ ...win, folders, activeFile: 'D:\\data\\web\\src\\main.py' }), 'D:\\data\\web');
    assert.strictEqual(terminalRoot({ ...win, folders }), 'C:\\work\\api');
  });

  it('never a drive root, the home folder or a folder above home', () => {
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\api', 'C:\\web'] }), 'C:\\api');
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\Users\\Dev\\api', 'C:\\Users\\Dev\\web'] }), 'C:\\Users\\Dev\\api');
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\Users\\Dev\\api', 'C:\\Users\\Other\\web'] }), 'C:\\Users\\Dev\\api');
    assert.strictEqual(
      terminalRoot({ ...win, folders: ['C:\\Users\\Dev\\api', 'C:\\Users\\Dev\\web'], workspaceFile: 'C:\\Users\\Dev\\all.code-workspace' }),
      'C:\\Users\\Dev\\api',
    );
  });

  it('a prefix that is not a whole folder name is not a common parent', () => {
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\work\\shop-api', 'C:\\work\\shop-web'] }), 'C:\\work');
    assert.strictEqual(terminalRoot({ ...posix, folders: ['/srv/app', '/srv/app-old'] }), '/srv');
  });

  it('nested folders open in the outer one; posix paths', () => {
    assert.strictEqual(terminalRoot({ ...posix, folders: ['/home/dev/shop', '/home/dev/shop/libs/core'] }), '/home/dev/shop');
    assert.strictEqual(terminalRoot({ ...posix, folders: ['/home/dev/a', '/opt/b'] }), '/home/dev/a');
  });

  // A set as Worktree Maker / aihub write it: <sets root>\<id>-<slug>\<repo>, with the set file and the workspace file in
  // the set folder. The clones themselves sit next to the sets root, so their common parent is the folder of all clones.
  const setDir = 'C:\\git\\worktrees\\42-export';
  const isSet = (dir: string) => dir.toLowerCase() === setDir.toLowerCase();

  it('a set with a reused clone outside the set folder opens in the set folder, not in the folder of all clones', () => {
    const folders = [`${setDir}\\repo-a`, 'C:\\git\\repo-b'];
    assert.strictEqual(terminalRoot({ ...win, folders, workspaceFile: `${setDir}\\42-export.code-workspace`, isSetFolder: isSet }), setDir);
    // also without the workspace file (folders opened another way): the one set folder they lie in
    assert.strictEqual(terminalRoot({ ...win, folders, isSetFolder: isSet }), setDir);
  });

  it('a set whose worktrees all lie in the set folder opens in the set folder', () => {
    const folders = [`${setDir}\\repo-a`, `${setDir}\\repo-b`];
    assert.strictEqual(terminalRoot({ ...win, folders, workspaceFile: `${setDir}\\42-export.code-workspace`, isSetFolder: isSet }), setDir);
  });

  it('never above the folder of the workspace file, also without a set file', () => {
    const folders = [`${setDir}\\repo-a`, 'C:\\git\\repo-b'];
    assert.strictEqual(terminalRoot({ ...win, folders, workspaceFile: `${setDir}\\42-export.code-workspace`, isSetFolder: () => false }), setDir);
    assert.strictEqual(terminalRoot({ ...win, folders, workspaceFile: `${setDir}\\42-export.code-workspace` }), setDir);
  });

  it('folders of two different sets: no set folder, the common parent as before', () => {
    const folders = ['C:\\git\\worktrees\\42-export\\repo-a', 'C:\\git\\worktrees\\43-import\\repo-b'];
    const both = (dir: string) => /\\4[23]-[a-z]+$/.test(dir);
    assert.strictEqual(terminalRoot({ ...win, folders, isSetFolder: both }), 'C:\\git\\worktrees');
  });

  it('a set folder that is a drive root or home is not used', () => {
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\repo-a', 'C:\\repo-b'], isSetFolder: () => true }), 'C:\\repo-a');
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\Users\\Dev\\repo-a', 'C:\\Users\\Dev\\repo-b'], isSetFolder: (d) => d === 'C:\\Users\\Dev' }), 'C:\\Users\\Dev\\repo-a');
  });

  it('one folder or none: nothing to decide', () => {
    assert.strictEqual(terminalRoot({ ...win, folders: ['C:\\work\\api'] }), undefined);
    assert.strictEqual(terminalRoot({ ...win, folders: [] }), undefined);
  });
});
