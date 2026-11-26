/**
 * One message per action. While an action runs inside withUndo the "stays" sentences of the open result are held back (they go
 * to the log); withUndo then shows one message in plain words, with Undo. No vscode here.
 */
let held: string[] | undefined;

/** Starts holding; the returned function stops it and gives back what was held. */
export function holdNotices(): () => string[] {
  const before = held;
  const mine: string[] = [];
  held = mine;
  return () => {
    held = before;
    return mine;
  };
}

/** Shows the text, or keeps it when an action is running. */
export function notice(text: string, show: (t: string) => void): void {
  if (held) held.push(text);
  else show(text);
}
