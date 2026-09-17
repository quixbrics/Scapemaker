/*
 * Save back to the file you opened, where the browser allows it.
 *
 * Every save used to go through a download, so a student pressing Cmd+S ten
 * times over an afternoon ended up with "Soundscape (9).scapemaker" in
 * Downloads and no idea which was current. The File System Access API lets us
 * write back to the same file; it is a Chromium-only API, which suits a tool
 * already gated to desktop widths, and there is a download fallback for
 * everything else.
 *
 * The handle is remembered for the session only. Persisting it across reloads
 * would need IndexedDB plus a re-permission prompt, which is more ceremony
 * than a re-pick.
 */

/** The slice of the File System Access API we use, absent from the default lib. */
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}
interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
}
type PermissionMode = { mode: 'read' | 'readwrite' };

export interface ProjectFileHandle {
  readonly name: string;
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
  queryPermission?(opts: PermissionMode): Promise<PermissionState>;
  requestPermission?(opts: PermissionMode): Promise<PermissionState>;
}

interface PickerWindow {
  showSaveFilePicker?(opts?: SaveFilePickerOptions): Promise<ProjectFileHandle>;
  showOpenFilePicker?(opts?: OpenFilePickerOptions): Promise<ProjectFileHandle[]>;
}

const picker = window as unknown as PickerWindow;

const PROJECT_TYPE: FilePickerAcceptType = {
  description: 'ScapeMaker project',
  accept: { 'application/json': ['.scapemaker'] },
};

export function supportsFileSystemAccess(): boolean {
  return typeof picker.showSaveFilePicker === 'function';
}

/** Thrown-by-the-browser cancellation, which is not an error worth reporting. */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

let current: ProjectFileHandle | null = null;

export function currentHandle(): ProjectFileHandle | null {
  return current;
}
export function setCurrentHandle(handle: ProjectFileHandle | null): void {
  current = handle;
}

/**
 * Can we still write to the remembered file? Chromium drops the grant when the
 * tab is reloaded or the file moves, and re-requesting needs a user gesture —
 * which every save path has, being a click or a key press.
 */
export async function ensureWritable(handle: ProjectFileHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  const opts: PermissionMode = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

export async function pickSaveFile(suggestedName: string): Promise<ProjectFileHandle | null> {
  if (!picker.showSaveFilePicker) return null;
  return picker.showSaveFilePicker({ suggestedName, types: [PROJECT_TYPE] });
}

export async function pickOpenFile(): Promise<ProjectFileHandle | null> {
  if (!picker.showOpenFilePicker) return null;
  const [handle] = await picker.showOpenFilePicker({ types: [PROJECT_TYPE], multiple: false });
  return handle ?? null;
}

export async function writeToHandle(handle: ProjectFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}
