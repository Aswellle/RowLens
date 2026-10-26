/**
 * Clipboard writes with a graceful fallback.
 *
 * The async Clipboard API is unavailable in non-secure contexts (e.g. a file
 * served over plain HTTP on a LAN) and can reject when the document is not
 * focused. The deprecated execCommand path still works there, so both cell
 * copy and range copy share one implementation instead of duplicating it.
 * Returns whether the write is believed to have succeeded — callers must tell
 * the user when it did not.
 */
export function copyWithExecCommand(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused — try the legacy path.
    }
  }
  return copyWithExecCommand(text);
}
