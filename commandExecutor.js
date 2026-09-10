/**
 * commandExecutor.js
 *
 * Asynchronous background shell command executor for Gnome Gemini.
 * Executes commands using Gio.Subprocess without blocking the GNOME Shell main loop,
 * and reports execution status, duration, stdout, stderr, and exit codes.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class CommandExecutor {
    /**
     * Executes a shell command asynchronously in the background.
     *
     * @param {string} command - Shell command to execute
     * @param {Gio.Cancellable} [cancellable] - Optional cancellable object
     * @returns {Promise<Object>} Execution result { success, exitCode, stdout, stderr, error, durationMs, isCancelled }
     */
    static run(command, cancellable = null) {
        return new Promise((resolve) => {
            if (!command || command.trim() === '') {
                resolve({
                    success: false,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    error: 'Nenhum comando fornecido para execução.',
                    durationMs: 0,
                    isCancelled: false,
                });
                return;
            }

            const startTime = GLib.get_monotonic_time();
            let proc;

            try {
                proc = new Gio.Subprocess({
                    argv: ['/bin/bash', '-c', command],
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(cancellable);
            } catch (err) {
                const durationMs = Math.round((GLib.get_monotonic_time() - startTime) / 1000);
                resolve({
                    success: false,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    error: err.message || String(err),
                    durationMs,
                    isCancelled: false,
                });
                return;
            }

            let cancelId = 0;
            if (cancellable) {
                cancelId = cancellable.connect(() => {
                    try {
                        proc.force_exit();
                    } catch (_) {}
                });
            }

            proc.communicate_utf8_async(null, cancellable, (_proc, res) => {
                if (cancelId && cancellable) {
                    cancellable.disconnect(cancelId);
                }

                const durationMs = Math.round((GLib.get_monotonic_time() - startTime) / 1000);

                try {
                    const [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                    const exitCode = proc.get_exit_status();
                    const success = proc.get_successful();

                    // Cap output length if extraordinarily large to prevent St.Label freezing
                    const MAX_CHARS = 30000;
                    let safeStdout = stdout || '';
                    if (safeStdout.length > MAX_CHARS) {
                        safeStdout = safeStdout.slice(0, MAX_CHARS) + '\n... [saída truncada]';
                    }
                    let safeStderr = stderr || '';
                    if (safeStderr.length > MAX_CHARS) {
                        safeStderr = safeStderr.slice(0, MAX_CHARS) + '\n... [saída de erro truncada]';
                    }

                    resolve({
                        success,
                        exitCode,
                        stdout: safeStdout,
                        stderr: safeStderr,
                        error: null,
                        durationMs,
                        isCancelled: false,
                    });
                } catch (err) {
                    const isCancelled = (cancellable && cancellable.is_cancelled()) ||
                        (err.matches && err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));

                    resolve({
                        success: false,
                        exitCode: -1,
                        stdout: '',
                        stderr: '',
                        error: isCancelled ? 'Execução cancelada pelo usuário.' : (err.message || String(err)),
                        durationMs,
                        isCancelled: Boolean(isCancelled),
                    });
                }
            });
        });
    }
}
