/** Browser chrome copies through trusted IPC, independent of website permissions. */
export async function copyText(text: string): Promise<void> {
  const result = await window.vast.browser.writeClipboardText(text)
  if (!result.ok) throw new Error(result.error || 'Could not copy to the clipboard.')
}
