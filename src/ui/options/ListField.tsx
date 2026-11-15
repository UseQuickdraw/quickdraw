import { useEffect, useState } from 'preact/hooks';

/**
 * A number box that saves when you leave it (or press Enter), and keeps what
 * you're typing through the page's background refreshes.
 */
export function SavedNumber(props: { value: number; step: string; min: string; onSave(n: number): void }) {
  const [draft, setDraft] = useState(String(props.value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(props.value));
  }, [props.value, editing]);
  const commit = () => {
    setEditing(false);
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0 && n !== props.value) props.onSave(n);
    else setDraft(String(props.value));
  };
  return (
    <input
      type="number"
      step={props.step}
      min={props.min}
      value={draft}
      onFocus={() => setEditing(true)}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/**
 * A text box (or textarea) holding a list: words, names or addresses. It keeps
 * what you type as you type it, passes the parsed list up on every keystroke,
 * and only rewrites the text when the list changes from outside (so the page's
 * background refreshes don't wipe a half-typed entry).
 */
export function ListField(props: {
  value: readonly string[];
  parse(raw: string): string[];
  onList(list: string[]): void;
  /** How the list is shown when written out. */
  sep?: string;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  const sep = props.sep ?? ', ';
  const [draft, setDraft] = useState(props.value.join(sep));
  const key = props.value.join('\u0000');
  useEffect(() => {
    if (props.parse(draft).join('\u0000') !== key) setDraft(props.value.join(sep));
    // Only when the list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const onInput = (e: Event) => {
    const raw = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    setDraft(raw);
    props.onList(props.parse(raw));
  };
  return props.multiline ? (
    <textarea rows={props.rows ?? 2} placeholder={props.placeholder} value={draft} onInput={onInput} />
  ) : (
    <input placeholder={props.placeholder} value={draft} onInput={onInput} />
  );
}
