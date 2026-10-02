export {
  cancelCommands,
  json,
  saveJson,
  commitJsonFiles,
  run,
  cleanEnvironment,
  shellQuote,
} from '../posix-common.mjs';

export function xml(value) {
  return String(value).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c],
  );
}
export function preferences(input = {}) {
  for (const key of ['startAtLogin', 'connectOnStartup', 'closeToMenuBar', 'minimizeToMenuBar'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new Error(`Invalid preference: ${key}`);
  return {
    startAtLogin: input.startAtLogin ?? false,
    connectOnStartup: input.connectOnStartup ?? false,
    closeToMenuBar: input.closeToMenuBar ?? true,
    minimizeToMenuBar: input.minimizeToMenuBar ?? false,
  };
}
