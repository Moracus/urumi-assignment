import { useEffect, useState } from 'react';
import { historySearch, parseHistory, type Filters } from './audit-query.js';

export function concreteWindow(preset = 'day') {
  const to = new Date().toISOString();
  const span = preset === 'hour' ? 3600000 : preset === 'week' ? 604800000 : 86400000;
  return { from: new Date(Date.parse(to) - span).toISOString(), to };
}
export function metricsWindow(filters: Filters) {
  return !!filters.from && !!filters.to && Date.parse(filters.to) - Date.parse(filters.from) <= 604800000;
}
export function investigationLink(path: 'servers' | 'observability' | 'audit', filters: Filters) {
  return `/admin/${path}?${historySearch(filters, 1)}`;
}
export function useInvestigation() {
  function read() {
    try {
      decodeURIComponent(location.search);
      const params = new URLSearchParams(location.search);
      const bucket = params.get('bucket') ?? '';
      if (params.getAll('bucket').length > 1 || (params.has('bucket') && !['5minute', 'hour', 'day'].includes(bucket))) throw new Error('Invalid activity bucket.');
      params.delete('bucket');
      const parsed = parseHistory(params.toString());
      if (!parsed.filters.from && !parsed.filters.to) Object.assign(parsed.filters, concreteWindow());
      if (!parsed.filters.from || !parsed.filters.to) throw new Error('Supply both inclusive From and exclusive To bounds.');
      return { filters: parsed.filters, bucket, error: '' };
    } catch (error) {
      return { filters: parseHistory('').filters, bucket: '', error: error instanceof Error ? error.message : 'Invalid investigation filters.' };
    }
  }
  const [view, setView] = useState(read);
  useEffect(() => {
    const restore = () => setView(read());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    if (!view.error) history.replaceState(null, '', `${location.pathname}?${historySearch(view.filters, 1)}${view.bucket ? `&bucket=${view.bucket}` : ''}`);
  }, [view]);
  function navigate(filters: Filters, bucket = view.bucket) {
    history.pushState(null, '', `${location.pathname}?${historySearch(filters, 1)}${bucket ? `&bucket=${bucket}` : ''}`);
    setView(read());
  }
  return { ...view, navigate, reset: () => navigate({ ...parseHistory('').filters, ...concreteWindow() }, '') };
}
