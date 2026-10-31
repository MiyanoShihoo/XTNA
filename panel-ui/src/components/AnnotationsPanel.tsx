import { useCallback, useEffect, useRef, useState } from "react";

import {
  appendAnnotation,
  fetchAnnotations,
  type AnnotationsState,
} from "../panel";
import { useI18n } from "../i18n";

const MAX_NOTE = 2000;

export function AnnotationsPanel({
  target,
  refreshTick,
}: {
  target: string;
  refreshTick: number;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<AnnotationsState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [targetValue, setTargetValue] = useState(target);
  const [posting, setPosting] = useState(false);
  const sequence = useRef(0);
  const targetDirty = useRef(false);

  useEffect(() => {
    if (!targetDirty.current) setTargetValue(target);
  }, [target]);

  const load = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const next = await fetchAnnotations();
      if (id !== sequence.current) return;
      setState(next);
      setLoadError(next.error ?? "");
    } catch (error) {
      if (id !== sequence.current) return;
      setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const submit = async () => {
    const trimmedTarget = targetValue.trim();
    const trimmedNote = note.trim();
    if (trimmedTarget.length === 0 || trimmedNote.length === 0 || posting)
      return;
    setPosting(true);
    setStatus("");
    try {
      const result = await appendAnnotation(trimmedTarget, trimmedNote);
      if (result.record === undefined) {
        setStatus(`${t("noteFailed")}: ${result.error ?? result.status}`);
        if (result.status === 403) await load();
        return;
      }
      setNote("");
      setStatus(t("noteSaved"));
      await load();
    } catch (error) {
      setStatus(`${t("noteFailed")}: ${String(error)}`);
    } finally {
      setPosting(false);
    }
  };

  if (loadError.length > 0) {
    return (
      <div className="notesPanel">
        <p className="errorText">
          {t("notesError")}: {loadError}
        </p>
        <button type="button" className="ghost" onClick={() => void load()}>
          {t("retry")}
        </button>
      </div>
    );
  }

  if (state === null) return <p className="dim">{t("loading")}</p>;

  if (!state.enabled) {
    return (
      <div className="notesPanel">
        <p className="dim">{t("notesDisabled")}</p>
      </div>
    );
  }

  const rows = [...state.annotations].reverse();

  return (
    <div className="notesPanel">
      {loadError.length > 0 && (
        <p className="errorText small">
          {t("notesError")}: {loadError}
        </p>
      )}
      <form
        className="noteComposer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>{t("noteTarget")}</span>
          <input
            value={targetValue}
            placeholder="0x140001008"
            onChange={(event) => {
              targetDirty.current = true;
              setTargetValue(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>
            {t("noteBody")}
            <span className="dim">
              {" "}
              · {note.length}/{MAX_NOTE}
            </span>
          </span>
          <textarea
            value={note}
            maxLength={MAX_NOTE}
            rows={4}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <div className="noteActions">
          <button
            type="submit"
            disabled={
              posting ||
              note.trim().length === 0 ||
              targetValue.trim().length === 0
            }
          >
            {posting ? t("running") : t("saveNote")}
          </button>
          {status.length > 0 && (
            <span className="dim" aria-live="polite">
              {status}
            </span>
          )}
        </div>
      </form>

      {state.truncated && (
        <p className="warnBadge inline">
          {t("notesTruncated")} {state.total}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="dim">{t("noNotes")}</p>
      ) : (
        <ul className="noteList">
          {rows.map((annotation) => (
            <li
              key={`${annotation.created_at}:${annotation.target}:${annotation.note}`}
            >
              <div className="noteHead">
                <span className="mono emerald">{annotation.target}</span>
                <time className="mono dim">{annotation.created_at}</time>
              </div>
              <p>{annotation.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
