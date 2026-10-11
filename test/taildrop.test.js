// Run: gjs -m test/taildrop.test.js
// receiveWaitingFiles against a fake tailscaled and a temp folder: no overwrites, no path escapes,
// files only deleted from tailscaled after they are saved.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {receiveWaitingFiles} from '../taildrop.js';

const dir = Gio.File.new_for_path(GLib.dir_make_tmp('tailnet-test-XXXXXX'));
dir.get_child('report.pdf').replace_contents(new TextEncoder().encode('old'), null, false, Gio.FileCreateFlags.NONE, null);

const incoming = {'report.pdf': 'new report', '../escape.txt': 'should stay inside', 'fail.bin': null};
const deleted = [];
const fakeApi = {
    cancellable: null,
    waitingFiles: async () => Object.keys(incoming).map(Name => ({Name})),
    openWaitingFile: async name => {
        if (incoming[name] === null)
            throw new Error('daemon error');
        return Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(new TextEncoder().encode(incoming[name])));
    },
    deleteWaitingFile: async name => deleted.push(name),
};

const read = name => new TextDecoder().decode(dir.get_child(name).load_contents(null)[1]);
const list = () => {
    const names = [];
    const e = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = e.next_file(null));)
        names.push(info.get_name());
    return names.sort();
};

const loop = new GLib.MainLoop(null, false);
let failure = null;
(async () => {
    let error = null;
    await receiveWaitingFiles(fakeApi, dir).catch(e => (error = e));
    if (error?.message !== 'daemon error')
        throw new Error(`expected daemon error to surface, got ${error}`);
    const check = (cond, msg) => {
        if (!cond)
            throw new Error(`FAIL: ${msg}`);
    };
    check(JSON.stringify(list()) === JSON.stringify(['escape.txt', 'report (1).pdf', 'report.pdf']), `files on disk: ${list()}`);
    check(read('report.pdf') === 'old', 'existing file not overwritten');
    check(read('report (1).pdf') === 'new report', 'new file saved under numbered name');
    check(read('escape.txt') === 'should stay inside', 'path-traversal name saved inside folder');
    check(!dir.get_parent().get_child('escape.txt').query_exists(null), 'nothing written outside folder');
    check(JSON.stringify(deleted) === JSON.stringify(['report.pdf', '../escape.txt']), `deleted from daemon: ${deleted}`);
    print('taildrop tests passed');
})().catch(e => (failure = e)).finally(() => {
    for (const name of list())
        dir.get_child(name).delete(null);
    dir.delete(null);
    loop.quit();
});
loop.run();
if (failure) {
    printerr(failure);
    System.exit(1);
}
