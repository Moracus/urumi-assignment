import { useEffect, useRef, type ReactNode } from 'react';

export function StatusBadge({ children }: { children: ReactNode }) {
  return <span className="status-badge">{children}</span>;
}

// Native modal semantics provide containment and make the background inert.
export function Dialog({ label, pending, close, children }: {
  label: string; pending: boolean; close: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>('[data-dialog-cancel]')?.focus();
    return () => {
      dialog?.close();
      // Disabled triggers can become enabled in the same React commit.
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        else document.getElementById('main-content')?.focus();
      });
    };
  }, []);
  return <dialog ref={ref} aria-label={label} aria-modal="true" aria-busy={pending}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]');
      if (!controls?.length) { event.preventDefault(); ref.current?.focus(); return; }
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}
    onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <h2>{label}</h2>
    {children}
    <button type="button" data-dialog-cancel disabled={pending} onClick={close}>Cancel</button>
    {pending && <p role="status">Action pending. Wait for confirmation before closing.</p>}
  </dialog>;
}

// Callers retain only data from the current authorized view; session changes
// unmount that view. A read failure never turns a previous result into zeroes.
export function ReadState({ loading, error, hasData, empty = false, emptyMessage = 'No results.', children }: {
  loading: boolean; error: string; hasData: boolean; empty?: boolean;
  emptyMessage?: string; children: ReactNode;
}) {
  return <>
    {loading && <p role="status">{hasData ? 'Refreshing data…' : 'Loading summary…'}</p>}
    {error && <p role="alert">{error}</p>}
    {hasData && (loading || error) && <p role="status">Stale data — showing the last successful read. {error ? 'Refresh failed.' : 'Refresh in progress.'}</p>}
    {hasData && (empty ? <p>{emptyMessage}</p> : children)}
  </>;
}
