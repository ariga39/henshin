import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { effectiveTagOrigins, effectiveTitle, ehBatchLookupBody, ehBatchResultMessage, ehLookupBody, ehLookupMessage, entryDraft, entryPatch, entryPath, isComposingEnter, isCurrentSelection, libraryQuery, refreshEntryDraft, runEhLookupBatch, sameServerOrigin, shouldRemoveFromAutoFilter, updateEntryDraft, type EhBatchResult, type EntryDraft } from './libraryState.js';

declare global {
  interface Window {
    henshin: {
      getConfig(): Promise<Config>;
      saveConfig(config: {
        connection: {
          url: string;
          token?: string;
          tokenConfigured?: boolean;
        };
        mappings: Record<string, string>;
        readers: Reader[];
      }): Promise<Config>;
      request<T>(url: string, method?: string, body?: unknown): Promise<T>;
      chooseDirectory(): Promise<string | null>;
      chooseExecutable(): Promise<string | null>;
      mapRoot(id: string, folder: string): Promise<Record<string, string>>;
      saveReaders(readers: Reader[]): Promise<Reader[]>;
      openEntry(entry: {
        id: string;
        rootId: string;
        relativePath: string;
        readerId: string;
      }): Promise<{
        stats?: { openCount: number; lastOpenedAt: number | null };
        warning?: string;
      }>;
    };
  }
}

type View = 'Library' | 'Roots & Scans' | 'Settings';
type Root = {
  id: string;
  label: string;
  serverPath: string;
  exclusions: string[];
};
type Entry = {
  id: string;
  rootId: string;
  relativePath: string;
  status: string;
  title: string;
  customTitle?: string;
  ehTitle?: string;
  ehTitleJpn?: string;
  pageCount: number;
  coverKey?: string;
  openCount: number;
  lastOpenedAt?: number | null;
  note?: string;
  effectiveTitle?: string;
  ehDisplayTitle?: string;
  tags?: string[];
  ehTags?: string[];
  localTags?: string[];
  hiddenTags?: string[];
  ehGid?: string;
  ehToken?: string;
  ehDomain?: string;
  ehBindSource?: 'auto' | 'manual' | null;
  ehRefreshedAt?: number | null;
  ehError?: string | null;
  coverSha1?: string | null;
};
type EhCandidate = { gid: string; token: string; domain: string; url: string; title: string };
type EhBatchProgress = {
  running: boolean;
  total: number;
  processed: number;
  currentTitle?: string;
  preparing?: boolean;
  error?: string;
  cancelled?: boolean;
  cancelRequested?: boolean;
  blocked?: boolean;
  results: Array<{ id: string; title: string; kind: EhBatchResult<Entry>['kind']; message?: string }>;
};
type EhSettings = {
  site: 'e-hentai.org' | 'exhentai.org';
  credentialsConfigured: boolean;
  language: string;
  useThumbnails: boolean;
  searchGid: boolean;
  preferOriginalTitle: boolean;
  additionalTags: boolean;
  includeExpunged: boolean;
  interval: number;
  sendCookiesToEHentai: boolean;
};
type Reader = {
  id: string;
  name: string;
  mode: 'executable' | 'system';
  executable?: string;
  args: string[];
  isDefault: boolean;
};
type Config = {
  connection: { url: string; tokenConfigured: boolean };
  mappings: Record<string, string>;
  readers: Reader[];
};
type Scan = {
  id: string;
  rootId: string;
  status: string;
  found: number;
  indexed: number;
  errors: number | string[];
};

const formatTimestamp = (seconds?: number | null) =>
  seconds ? new Date(seconds * 1000).toLocaleString() : 'Never';

const scanErrorCount = (errors: Scan['errors']) =>
  typeof errors === 'number' ? errors : errors.length;

const emptyConfig: Config = {
  connection: { url: '', tokenConfigured: false },
  mappings: {},
  readers: [],
};

function App() {
  const [tab, setTab] = useState<View>('Library');
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [connectionUrl, setConnectionUrl] = useState('');
  const [token, setToken] = useState('');
  const [health, setHealth] = useState('');
  const [roots, setRoots] = useState<Root[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const scanStatus = scans.map((scanItem) => `${scanItem.id}:${scanItem.status}`).join(',');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [ehBatchProgress, setEhBatchProgress] = useState<EhBatchProgress | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const selectedEntryId = selected?.id;
  const selectedEntryIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<EntryDraft | null>(null);
  const [savingEntryId, setSavingEntryId] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [includeTags, setIncludeTags] = useState<string[]>([]);
  const [excludeTags, setExcludeTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [tagMode, setTagMode] = useState<'include' | 'exclude'>('include');
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [sort, setSort] = useState('added');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [editTag, setEditTag] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [rootId, setRootId] = useState('');
  const [status, setStatus] = useState('active');
  const [ehBindSource, setEhBindSource] = useState<'' | 'auto'>('');
  const [readerId, setReaderId] = useState('');
  const [ehQuery, setEhQuery] = useState('');
  const [ehUrl, setEhUrl] = useState('');
  const [ehCandidates, setEhCandidates] = useState<EhCandidate[]>([]);
  const [ehBusy, setEhBusy] = useState(false);
  const [ehMessage, setEhMessage] = useState('');
  const [ehSettings, setEhSettings] = useState<EhSettings>({
    site: 'e-hentai.org', credentialsConfigured: false, language: '', useThumbnails: false,
    searchGid: false, preferOriginalTitle: false, additionalTags: false, includeExpunged: false,
    interval: 4, sendCookiesToEHentai: false,
  });
  const [ehLookupSite, setEhLookupSite] = useState<'' | EhSettings['site']>('');
  const [ehCookieHeader, setEhCookieHeader] = useState('');
  const [ehSettingsMessage, setEhSettingsMessage] = useState('');
  const [newRoot, setNewRoot] = useState({
    label: '',
    serverPath: '',
    exclusions: '',
  });
  const [rootEdit, setRootEdit] = useState<{
    id: string;
    label: string;
    exclusions: string;
  } | null>(null);
  const [reader, setReader] = useState<Reader>({
    id: crypto.randomUUID(),
    name: '',
    mode: 'executable',
    executable: '',
    args: [],
    isDefault: true,
  });
  const [readerArgs, setReaderArgs] = useState('');
  const refreshGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const batchRunning = useRef(false);
  const batchCancelled = useRef(false);
  const batchWait = useRef<{ timer: ReturnType<typeof setTimeout>; resolve: () => void } | null>(null);
  const refreshCurrentRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const call = async <T,>(
    url: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> => window.henshin.request(url, method, body);

  const saveConnection = async (
    nextConfig: Config,
    nextToken = token,
  ): Promise<Config> => {
    const saved = await window.henshin.saveConfig({
      ...nextConfig,
      connection: { ...nextConfig.connection, token: nextToken },
    });
    if (!sameServerOrigin(config.connection.url, saved.connection.url)) {
      refreshGeneration.current += 1;
      selectionGeneration.current += 1;
      selectedEntryIdRef.current = null;
      setRoots([]);
      setScans([]);
      setEntries([]);
      setSelected(null);
      setRootId('');
      setOffset(0);
      setTotal(0);
      setDraft(null);
      setTagSuggestions([]);
      setHealth('');
    }
    setConfig(saved);
    setConnectionUrl(saved.connection.url);
    setToken('');
    return saved;
  };

  const refresh = async (rootFilter = rootId, pageOffset = offset) => {
    const generation = ++refreshGeneration.current;
    setError('');
    try {
      const queryString = libraryQuery({ q: query, includeTags, excludeTags, rootId: rootFilter, status, sort, limit: 100, offset: pageOffset, ...(ehBindSource ? { ehBindSource } : {}) });
      const [rootResult, entryResult, scanResult] = await Promise.all([
        call<{ roots: Root[] }>('/api/roots'),
        call<{ entries: Entry[]; total: number }>(`/api/entries?${queryString}`),
        call<{ scans: Scan[] }>('/api/scans'),
      ]);
      if (generation !== refreshGeneration.current) return;
      setRoots(rootResult.roots);
      setEntries(entryResult.entries);
      const pageEntryIds = new Set(entryResult.entries.map((entry) => entry.id));
      setBatchSelectedIds((current) => current.filter((id) => pageEntryIds.has(id)));
      setTotal(entryResult.total);
      setScans(scanResult.scans);
      const selectedId = selectedEntryIdRef.current;
      if (selectedId) {
        const selectionVersion = selectionGeneration.current;
        let refreshedEntry = entryResult.entries.find((entry) => entry.id === selectedId);
        if (!refreshedEntry) {
          try {
            refreshedEntry = await call<Entry>(entryPath(selectedId));
          } catch (caught) {
            if (generation === refreshGeneration.current
              && isCurrentSelection(selectedId, selectedEntryIdRef.current, selectionVersion, selectionGeneration.current)) {
              setError((caught as Error).message);
            }
            return;
          }
          if (generation !== refreshGeneration.current
            || !isCurrentSelection(selectedId, selectedEntryIdRef.current, selectionVersion, selectionGeneration.current)) return;
        }
        if (refreshedEntry) {
          setSelected((current) => current?.id === selectedId ? refreshedEntry : current);
          setDraft((current) => refreshEntryDraft(current, refreshedEntry));
        }
      }
    } catch (caught) {
      if (generation === refreshGeneration.current) {
        setError((caught as Error).message);
      }
    }
  };
  refreshCurrentRef.current = () => refresh();

  const loadEhSettings = async () => {
    try {
      const settings = await window.henshin.request<EhSettings>('/api/settings/eh');
      setEhSettings(settings);
    } catch { /* Older servers may not expose this endpoint. */ }
  };

  useEffect(() => {
    window.henshin.getConfig().then((savedConfig: Config) => {
      setConfig(savedConfig);
      setConnectionUrl(savedConfig.connection.url);
      if (savedConfig.connection.url) { void refresh(); void loadEhSettings(); }
      const defaultReader =
        savedConfig.readers.find((candidate) => candidate.isDefault) ??
        savedConfig.readers[0];
      if (defaultReader) {
        setReader(defaultReader);
        setReaderArgs(defaultReader.args.join('\n'));
      }
    });
  }, []);

  useEffect(() => {
    setBatchSelectedIds([]);
    if (config.connection.url) void refresh();
  }, [status, rootId, query, includeTags, excludeTags, sort, offset, ehBindSource]);

  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => {
      if (query !== searchText.trim()) { setQuery(searchText.trim()); setOffset(0); }
    }, 200);
    return () => clearTimeout(timer);
  }, [searchText, composing]);

  useEffect(() => {
    if (!config.connection.url) return;
    void call<{ tags: string[] }>('/api/tags').then((result) => setTagSuggestions(result.tags)).catch(() => undefined);
  }, [config.connection.url, entries.length, selectedEntryId, scanStatus]);

  useEffect(() => {
    const hasRunningScan = scans.some((scanItem) => scanItem.status === 'running');
    if (!hasRunningScan) return;

    const timer = setInterval(() => void refresh(), 1300);
    return () => clearInterval(timer);
  }, [scans]);

  const testConnection = async () => {
    setError('');
    const sameServer = sameServerOrigin(config.connection.url, connectionUrl);
    if (!sameServer && !confirmDraftDiscard()) return;
    try {
      const savedConfig = await saveConnection(
        { ...config, connection: { ...config.connection, url: connectionUrl } },
        token,
      );
      const result = await call<{ serverId: string; version: string }>(
        '/api/health',
      );
      setHealth(`Connected to ${result.serverId} · v${result.version}`);
      setNotice('Connection tested successfully.');
      setConfig(savedConfig);
      if (sameServer) await refreshCurrentRef.current();
      else await refresh('', 0);
      await loadEhSettings();
    } catch (caught) {
      setHealth('');
      setError((caught as Error).message);
    }
  };

  const addRoot = async () => {
    try {
      await call('/api/roots', 'POST', {
        label: newRoot.label,
        serverPath: newRoot.serverPath,
        exclusions: newRoot.exclusions
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setNewRoot({ label: '', serverPath: '', exclusions: '' });
      await refresh();
      setNotice('Root added.');
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const saveEhSettings = async (clearCredentials = false) => {
    setEhSettingsMessage('');
    try {
      const updated = await window.henshin.request<EhSettings>('/api/settings/eh', 'PUT', {
        site: ehSettings.site,
        language: ehSettings.language,
        useThumbnails: ehSettings.useThumbnails,
        searchGid: ehSettings.searchGid,
        preferOriginalTitle: ehSettings.preferOriginalTitle,
        additionalTags: ehSettings.additionalTags,
        includeExpunged: ehSettings.includeExpunged,
        interval: ehSettings.interval,
        sendCookiesToEHentai: ehSettings.sendCookiesToEHentai,
        ...(ehCookieHeader ? { cookieHeader: ehCookieHeader } : {}),
        ...(clearCredentials ? { clearCredentials: true } : {}),
      });
      setEhSettings(updated); setEhCookieHeader('');
      setEhSettingsMessage(clearCredentials ? 'Credentials cleared.' : 'Settings saved.');
    } catch (caught) { setEhSettingsMessage((caught as Error).message); }
  };

  const startScan = async (id: string) => {
    try {
      await call(`/api/roots/${encodeURIComponent(id)}/scan`, 'POST');
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const saveReader = async () => {
    try {
      const savedReader = {
        ...reader,
        args: reader.mode === 'system' ? [] : readerArgs.split('\n').filter(Boolean),
      };
      const readers = [
        ...config.readers
          .filter((candidate) => candidate.id !== savedReader.id)
          .map((candidate) => ({
            ...candidate,
            isDefault: savedReader.isDefault ? false : candidate.isDefault,
          })),
        savedReader,
      ];
      await window.henshin.saveReaders(readers);
      setConfig({ ...config, readers });
      setReader(savedReader);
      setNotice('Reader saved on this device.');
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const openEntry = async (entry: Entry) => {
    setError('');
    try {
      const result = await window.henshin.openEntry({
        id: entry.id,
        rootId: entry.rootId,
        relativePath: entry.relativePath,
        readerId,
      });
      if (result.warning) {
        setNotice(result.warning);
        return;
      }

      setNotice('Reader launched. Open count updated.');
      await refreshCurrentRef.current();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const addReader = () => {
    const newReader: Reader = {
      id: crypto.randomUUID(),
      name: '',
      mode: 'executable',
      executable: '',
      args: [],
      isDefault: config.readers.length === 0,
    };
    setReader(newReader);
    setReaderArgs('');
  };

  const chooseLocalFolder = async (id: string) => {
    setError('');
    setNotice('');
    try {
      const folder = await window.henshin.chooseDirectory();
      if (!folder) return;

      const mappings = await window.henshin.mapRoot(id, folder);
      setConfig({ ...config, mappings });
      setNotice('Local folder mapping saved on this device.');
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const saveReaderList = async (readers: Reader[]) => {
    setError('');
    setNotice('');
    try {
      await window.henshin.saveReaders(readers);
      setConfig({ ...config, readers });
      setNotice('Reader settings saved on this device.');
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const removeRoot = async (root: Root) => {
    const accepted = confirm(
      `Remove root “${root.label}” from Henshin? Files are not changed.`,
    );
    if (!accepted) return;

    try {
      await call(`/api/roots/${encodeURIComponent(root.id)}`, 'DELETE');
      await refresh();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const saveRootEdit = async () => {
    if (!rootEdit) return;
    try {
      await call(`/api/roots/${encodeURIComponent(rootEdit.id)}`, 'PATCH', {
        label: rootEdit.label,
        exclusions: rootEdit.exclusions
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      });
      setRootEdit(null);
      await refresh();
      setNotice('Root updated.');
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const addFilterTag = () => {
    const tag = tagInput.trim();
    if (!tag) return;
    if (tagMode === 'include') setIncludeTags((tags) => tags.includes(tag) ? tags : [...tags, tag]);
    else setExcludeTags((tags) => tags.includes(tag) ? tags : [...tags, tag]);
    setOffset(0); setTagInput('');
  };

  const confirmDraftDiscard = () =>
    !draft?.dirty || window.confirm('Discard unsaved personal changes?');

  const selectEntry = async (entry: Entry) => {
    if (!confirmDraftDiscard()) return;
    const generation = ++selectionGeneration.current;
    selectedEntryIdRef.current = entry.id;
    setSelected(null);
    setDraft(null);
    setEhBusy(false);
    setEhCandidates([]); setEhMessage(''); setEhUrl(''); setEhQuery(''); setEhLookupSite('');
    setSavingEntryId(null);
    try {
      const detail = await call<Entry>(entryPath(entry.id));
      if (!isCurrentSelection(entry.id, selectedEntryIdRef.current, generation, selectionGeneration.current)) return;
      setSelected(detail); setDraft(entryDraft(detail)); setEditTag(''); setReaderId('');
    } catch (caught) {
      if (isCurrentSelection(entry.id, selectedEntryIdRef.current, generation, selectionGeneration.current)) {
        setError((caught as Error).message);
      }
    }
  };

  const lookupEh = async (mode: 'auto' | 'title' | 'cover') => {
    if (!selected) return;
    const entryId = selected.id; const generation = selectionGeneration.current;
    setEhLookupSite('');
    setEhBusy(true); setEhMessage(''); setEhCandidates([]);
    try {
      const includeExpunged = mode === 'title'
        ? (await call<EhSettings>('/api/settings/eh')).includeExpunged
        : undefined;
      const body = ehLookupBody(mode, ehQuery, mode === 'auto' ? '' : ehLookupSite, Boolean(selected.ehGid && selected.ehToken), includeExpunged);
      const result = await call<{ entry?: Entry; candidates: EhCandidate[]; autoBound?: boolean }>(`${entryPath(entryId)}/eh-lookup`, 'POST', {
        ...body,
      });
      if (!isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) return;
      if (result.entry) {
        setSelected(result.entry);
        setEntries((items) => items.map((item) => item.id === entryId ? result.entry! : item));
        setDraft((current) => refreshEntryDraft(current, result.entry!));
      }
      setEhCandidates(result.candidates);
      setEhMessage(ehLookupMessage(result.autoBound, result.candidates.length));
    } catch (caught) {
      if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) setEhMessage((caught as Error).message);
    } finally { if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) setEhBusy(false); }
  };

  const waitForBatchInterval = (milliseconds: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (batchWait.current?.timer === timer) batchWait.current = null;
      resolve();
    }, milliseconds);
    batchWait.current = { timer, resolve };
  });

  const cancelEhBatch = () => {
    if (!batchRunning.current) return;
    batchCancelled.current = true;
    setEhBatchProgress((current) => current ? { ...current, cancelRequested: true } : current);
    const pending = batchWait.current;
    if (pending) {
      clearTimeout(pending.timer);
      batchWait.current = null;
      pending.resolve();
    }
  };

  const runEhBatch = async () => {
    if (batchRunning.current || batchSelectedIds.length === 0) return;
    const selectedIds = new Set(batchSelectedIds);
    const batchEntries = entries.filter((entry) => selectedIds.has(entry.id));
    if (batchEntries.length === 0) return;
    batchRunning.current = true;
    batchCancelled.current = false;
    setEhBatchProgress({ running: true, total: batchEntries.length, processed: 0, preparing: true, results: [] });
    try {
      const summary = await runEhLookupBatch(
        batchEntries,
        async () => (await call<EhSettings>('/api/settings/eh')).interval,
        async (entry) => {
          const response = await call<{ entry?: Entry; candidates: EhCandidate[]; autoBound?: boolean; refreshedBinding?: boolean }>(
            `${entryPath(entry.id)}/eh-lookup`,
            'POST',
            ehBatchLookupBody(),
          );
          if (response.entry) {
            setEntries((items) => items.map((item) => item.id === entry.id ? response.entry! : item));
            setSelected((current) => current?.id === entry.id ? response.entry! : current);
            setDraft((current) => current?.entryId === entry.id ? refreshEntryDraft(current, response.entry!) : current);
          }
          return response;
        },
        waitForBatchInterval,
        () => batchCancelled.current,
        (entry, index) => setEhBatchProgress((current) => current ? {
          ...current,
          preparing: false,
          currentTitle: entry.effectiveTitle || effectiveTitle(entry),
          processed: index,
        } : current),
        (result) => setEhBatchProgress((current) => {
          if (!current) return current;
          const title = result.item.effectiveTitle || effectiveTitle(result.item);
          return {
            ...current,
            processed: current.processed + 1,
            currentTitle: undefined,
            results: [...current.results, { id: result.item.id, title, kind: result.kind, message: ehBatchResultMessage(result) }],
          };
        }),
      );
      setEhBatchProgress((current) => current ? {
        ...current,
        running: false,
        currentTitle: undefined,
        cancelled: summary.cancelled,
        blocked: summary.blocked,
      } : current);
      if (summary.processed > 0) {
        try {
          const tags = await call<{ tags: string[] }>('/api/tags');
          setTagSuggestions(tags.tags);
        } catch { /* Batch results remain useful if tag suggestions fail to refresh. */ }
      }
    } catch (caught) {
      setEhBatchProgress((current) => current ? {
        ...current,
        running: false,
        preparing: false,
        currentTitle: undefined,
        error: (caught as Error).message,
      } : current);
    } finally {
      batchRunning.current = false;
      batchWait.current = null;
    }
  };

  const bindEh = async (binding: { url: string } | { gid: string; token: string; domain: string }) => {
    if (!selected) return;
    const entryId = selected.id; const generation = selectionGeneration.current;
    setEhBusy(true); setEhMessage('');
    try {
      const updated = await call<Entry>(`${entryPath(entryId)}/eh-bind`, 'POST', binding);
      if (!isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) return;
      const removedFromAutoFilter = shouldRemoveFromAutoFilter(ehBindSource, entries.map((item) => item.id), entryId, updated.ehBindSource);
      setSelected(updated);
      if (removedFromAutoFilter) {
        setEntries((items) => items.filter((item) => item.id !== entryId));
        setTotal((current) => Math.max(0, current - 1));
        setBatchSelectedIds((ids) => ids.filter((id) => id !== entryId));
      } else {
        setEntries((items) => items.map((item) => item.id === entryId ? updated : item));
      }
      setDraft((current) => refreshEntryDraft(current, updated));
      setEhCandidates([]); setEhUrl(''); setEhMessage(updated.ehError || (removedFromAutoFilter ? 'Manual match saved; this entry no longer matches the auto-matched filter.' : 'Gallery binding saved.'));
      try { const tags = await call<{ tags: string[] }>('/api/tags'); setTagSuggestions(tags.tags); } catch { /* Existing suggestions remain usable. */ }
    } catch (caught) { if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) setEhMessage((caught as Error).message); }
    finally { if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) setEhBusy(false); }
  };

  const refreshEh = async () => {
    if (!selected) return;
    const entryId = selected.id; const generation = selectionGeneration.current;
    setEhBusy(true); setEhMessage('');
    try {
      const updated = await call<Entry>(`${entryPath(entryId)}/eh-refresh`, 'POST', {});
      if (!isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) return;
      setSelected(updated); setEntries((items) => items.map((item) => item.id === entryId ? updated : item));
      setDraft((current) => refreshEntryDraft(current, updated)); setEhMessage(updated.ehError || 'Metadata refreshed.');
      try { const tags = await call<{ tags: string[] }>('/api/tags'); setTagSuggestions(tags.tags); } catch { /* Existing suggestions remain usable. */ }
    } catch (caught) { if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) setEhMessage((caught as Error).message); }
    finally { if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)) setEhBusy(false); }
  };

  const saveEntry = async () => {
    if (!selected || !draft || selected.id !== draft.entryId || savingEntryId) return;
    const generation = selectionGeneration.current;
    const entryId = draft.entryId;
    const patch = entryPatch(draft);
    if (Object.keys(patch).length === 0) return;
    setSavingEntryId(entryId);
    let updated: Entry;
    try {
      updated = await call<Entry>(entryPath(entryId), 'PATCH', patch);
    } catch (caught) {
      setError((caught as Error).message);
      return;
    } finally {
      setSavingEntryId((current) => current === entryId ? null : current);
    }
    if (isCurrentSelection(entryId, selectedEntryIdRef.current, generation, selectionGeneration.current)
      && draft.entryId === entryId && updated.id === entryId) {
      setSelected(updated);
      setDraft(entryDraft(updated));
    }
    setNotice('Personal details saved.');
    await refreshCurrentRef.current();
    try {
      const tags = await call<{ tags: string[] }>('/api/tags');
      setTagSuggestions(tags.tags);
    } catch {
      // Tag suggestions are independent of saving personal details.
    }
  };

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">Henshin</div>
        <nav className="nav">
          {(['Library', 'Roots & Scans', 'Settings'] as const).map((view) => (
            <button
              key={view}
              className={tab === view ? 'active' : ''}
              disabled={ehBatchProgress?.running}
              onClick={() => setTab(view)}
            >
              {view}
            </button>
          ))}
        </nav>
      </header>

      {(error || notice) && (
        <div className={`notice ${error ? 'error' : 'success'}`}>
          {error || notice}
          <button
            style={{ float: 'right', padding: '2px 7px' }}
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {tab === 'Library' && (
        <main className="content">
          <div className="row batch-toolbar">
            <button disabled={ehBatchProgress?.running || entries.length === 0} onClick={() => setBatchSelectedIds(entries.map((entry) => entry.id))}>Select all on page</button>
            <button disabled={ehBatchProgress?.running || !entries.some((entry) => !entry.ehGid || !entry.ehToken)} onClick={() => setBatchSelectedIds(entries.filter((entry) => !entry.ehGid || !entry.ehToken).map((entry) => entry.id))}>Select unbound</button>
            <button disabled={ehBatchProgress?.running || batchSelectedIds.length === 0} onClick={() => setBatchSelectedIds([])}>Clear selection</button>
            <span className="muted">{batchSelectedIds.length} selected on this page</span>
            {ehBatchProgress?.running
              ? <button className="danger" onClick={cancelEhBatch}>Cancel batch</button>
              : <button className="primary" disabled={!config.connection.url || !config.connection.tokenConfigured || batchSelectedIds.length === 0} onClick={() => void runEhBatch()}>Look up selected</button>}
          </div>
          {ehBatchProgress && <section className="batch-summary" role="status" aria-live="polite">
            <p>{ehBatchProgress.running
              ? ehBatchProgress.preparing
                ? ehBatchProgress.cancelRequested ? 'Cancelling before the first lookup.' : 'Reading current server lookup settings…'
                : ehBatchProgress.cancelRequested
                ? `Finishing the current lookup; no further books will start (${ehBatchProgress.processed} of ${ehBatchProgress.total} complete).`
                : ehBatchProgress.currentTitle
                  ? `Processing ${ehBatchProgress.processed + 1} of ${ehBatchProgress.total}: ${ehBatchProgress.currentTitle}`
                  : `Completed ${ehBatchProgress.processed} of ${ehBatchProgress.total}; waiting before the next book.`
              : ehBatchProgress.error
                ? `Batch could not start: ${ehBatchProgress.error}`
              : ehBatchProgress.blocked
                ? `Stopped after an upstream access or rate block (${ehBatchProgress.processed} of ${ehBatchProgress.total} books).`
                : ehBatchProgress.cancelled
                  ? `Cancelled after ${ehBatchProgress.processed} of ${ehBatchProgress.total} books.`
                  : `Completed ${ehBatchProgress.processed} of ${ehBatchProgress.total} books.`}</p>
            {!!ehBatchProgress.results.length && <ul>{ehBatchProgress.results.map((result) => <li key={result.id}>{result.title} — {result.message}</li>)}</ul>}
          </section>}
          <div className="toolbar search-toolbar">
            <form className="search-form" onSubmit={(event) => { event.preventDefault(); setQuery(searchText.trim()); setOffset(0); }}>
              <input aria-label="Search titles and filenames" placeholder="Search titles and filenames" value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                onCompositionStart={() => setComposing(true)} onCompositionEnd={(event) => { const value = event.currentTarget.value; setComposing(false); setSearchText(value); setQuery(value.trim()); setOffset(0); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && (composing || event.nativeEvent.isComposing)) { event.preventDefault(); return; } if (event.key === 'Enter') { setQuery(searchText.trim()); setOffset(0); } }} />
              <button type="submit">Search</button>
              {searchText && <button type="button" onClick={() => { setSearchText(''); setQuery(''); setOffset(0); }}>Clear</button>}
            </form>
            <div className="tag-filter">
              <select aria-label="Tag filter mode" value={tagMode} onChange={(event) => setTagMode(event.target.value as 'include' | 'exclude')}>
                <option value="include">Include all</option><option value="exclude">Exclude</option>
              </select>
              <input list="tag-suggestions" aria-label="Filter by tag" placeholder="Type a tag and press Enter" value={tagInput}
                onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (isComposingEnter(event.key, event.nativeEvent.isComposing, event.nativeEvent.keyCode)) return; if (event.key === 'Enter') { event.preventDefault(); addFilterTag(); } }} />
              <datalist id="tag-suggestions">{tagSuggestions.map((tag) => <option key={tag} value={tag} />)}</datalist>
              <button onClick={addFilterTag}>Add tag</button>
            </div>
            <div className="chips">
              {[...includeTags.map((tag) => ({ tag, mode: 'include' as const })), ...excludeTags.map((tag) => ({ tag, mode: 'exclude' as const }))].map(({ tag, mode }) => (
                <button key={`${mode}:${tag}`} className="filter-chip" onClick={() => { (mode === 'include' ? setIncludeTags : setExcludeTags)((tags) => tags.filter((item) => item !== tag)); setOffset(0); }}>
                  {mode === 'include' ? '＋' : '−'} {tag} ×
                </button>
              ))}
            </div>
            <select value={rootId} onChange={(event) => { setRootId(event.target.value); setOffset(0); }}>
              <option value="">All roots</option>
              {roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.label}
                </option>
              ))}
            </select>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
              <option value="active">Active</option>
              <option value="missing">Missing</option>
            </select>
            <select aria-label="Gallery binding source" value={ehBindSource} onChange={(event) => { setEhBindSource(event.target.value as '' | 'auto'); setOffset(0); }}>
              <option value="">All gallery bindings</option>
              <option value="auto">Auto-matched only</option>
            </select>
            <select aria-label="Sort entries" value={sort} onChange={(event) => { setSort(event.target.value); setOffset(0); }}>
              <option value="added">Date added</option><option value="title">Title</option><option value="openCount">Open count</option><option value="lastOpened">Last opened</option>
            </select>
            <button onClick={() => void refresh()}>Refresh</button>
          </div>

          {!config.connection.url ? (
            <div className="empty">
              Connect to your Henshin server in Settings to load your library.
            </div>
          ) : entries.length === 0 ? (
            <div className="empty">
              {offset > 0
                ? 'No books on this page.'
                : 'No entries found. Try another search or filter, or add and scan a root under Roots & Scans.'}
            </div>
          ) : (
            <div className="grid">
              {entries.map((entry) => (
                <article
                  className="card"
                  key={entry.id}
                  onClick={() => void selectEntry(entry)}
                >
                  <label className="card-selection" onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" aria-label={`Select ${entry.effectiveTitle || effectiveTitle(entry)}`} checked={batchSelectedIds.includes(entry.id)} disabled={ehBatchProgress?.running} onChange={() => setBatchSelectedIds((ids) => ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id])} />
                    Select
                  </label>
                  <img
                    src={
                      entry.coverKey
                        ? `henshin-cover://${encodeURIComponent(entry.coverKey)}`
                        : ''
                    }
                    alt=""
                  />
                  <div className="meta">
                    <h3>{entry.effectiveTitle || effectiveTitle(entry)}</h3>
                    {entry.ehBindSource === 'auto' && <span className="status">Auto-matched</span>}
                    {!!entry.tags?.length && <div className="muted">{entry.tags.slice(0, 4).join(' · ')}{entry.tags.length > 4 ? ` · +${entry.tags.length - 4}` : ''}</div>}
                    <div className="muted">
                      {entry.pageCount} pages · Opened {entry.openCount}×
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {(total > 0 || offset > 0) && <div className="pagination">
            {entries.length > 0 && <span className="muted">Showing {offset + 1}–{Math.min(offset + entries.length, total)} of {total}</span>}
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>Previous</button>
            <button disabled={offset + entries.length >= total} onClick={() => setOffset(offset + 100)}>Next</button>
          </div>}

          {selected && draft && (
            <div className="panel detail">
              <div>
                {selected.coverKey && (
                  <img
                    src={`henshin-cover://${encodeURIComponent(selected.coverKey)}`}
                    alt=""
                  />
                )}
              </div>
              <div>
                <h2>{selected.effectiveTitle || effectiveTitle(selected)}</h2>
                <div className="muted">{selected.relativePath}</div>
                <div className="muted">{selected.ehDisplayTitle || selected.ehTitle || selected.ehTitleJpn || selected.title}</div>
                <p>
                  {selected.pageCount} pages · Opened {selected.openCount}× · Last
                  opened {formatTimestamp(selected.lastOpenedAt)}
                </p>
                <section className="editor-section eh-section">
                  <h3>E-Hentai gallery</h3>
                  {selected.ehGid && selected.ehToken ? <>
                    <a href={`https://${selected.ehDomain || 'e-hentai.org'}/g/${selected.ehGid}/${selected.ehToken}/`} target="_blank" rel="noreferrer">https://{selected.ehDomain || 'e-hentai.org'}/g/{selected.ehGid}/{selected.ehToken}/</a>
                    <div className="row"><span className={selected.ehBindSource === 'auto' ? 'status' : 'muted'}>{selected.ehBindSource === 'auto' ? 'Auto-matched' : selected.ehBindSource === 'manual' ? 'Manual match' : 'Source not recorded'}</span><span className="muted">{selected.ehDisplayTitle || selected.ehTitle || selected.ehTitleJpn || 'No source title'} · Refreshed {formatTimestamp(selected.ehRefreshedAt)}</span></div>
                    {selected.ehBindSource === 'auto' && <button disabled={ehBusy} onClick={() => void bindEh({ gid: selected.ehGid!, token: selected.ehToken!, domain: selected.ehDomain || 'e-hentai.org' })}>Confirm this match</button>}
                    <div className="row"><button disabled={ehBusy} onClick={() => void refreshEh()}>Refresh metadata</button></div>
                  </> : <p className="muted">No gallery bound.</p>}
                  <label className="field"><span>Optional search query</span><input value={ehQuery} onChange={(event) => setEhQuery(event.target.value)} placeholder={selected.title} /></label>
                  <label className="field"><span>Site for this search</span><select value={ehLookupSite} onChange={(event) => setEhLookupSite(event.target.value as '' | EhSettings['site'])}><option value="">Use server preference ({ehSettings.site})</option><option value="e-hentai.org">e-hentai.org</option><option value="exhentai.org">exhentai.org</option></select></label>
                  <div className="row"><button disabled={ehBusy} onClick={() => void lookupEh('auto')}>Search with server preferences</button>
                    <button disabled={ehBusy || !ehQuery.trim()} onClick={() => void lookupEh('title')}>Search explicit query</button>
                    <button disabled={ehBusy || !selected.coverSha1} onClick={() => void lookupEh('cover')}>Search by cover</button>
                  </div>
                  {ehBusy && <p className="muted">Contacting E-Hentai…</p>}
                  {ehCandidates.length > 0 && <div className="eh-candidates" aria-label="E-Hentai search candidates">{ehCandidates.map((candidate) => <div className="eh-candidate" key={`${candidate.gid}/${candidate.token}`}>
                    <a href={candidate.url} target="_blank" rel="noreferrer">{candidate.title}</a><div className="muted">Gallery {candidate.gid}</div>
                    {selected.ehGid === candidate.gid && selected.ehToken === candidate.token && selected.ehDomain === candidate.domain
                      ? <span className="muted">Currently bound</span>
                      : <button disabled={ehBusy} onClick={() => void bindEh({ gid: candidate.gid, token: candidate.token, domain: candidate.domain })}>Choose this gallery</button>}
                  </div>)}</div>}
                  <label className="field"><span>Bind or correct with a gallery URL</span><input value={ehUrl} onChange={(event) => setEhUrl(event.target.value)} placeholder="https://e-hentai.org/g/618395/0439fa3666/" /></label>
                  <button disabled={ehBusy || !ehUrl.trim()} onClick={() => void bindEh({ url: ehUrl.trim() })}>{selected.ehGid ? 'Bind / rebind URL' : 'Bind gallery URL'}</button>
                  {ehMessage && <p className="muted" role="status">{ehMessage}</p>}
                  {selected.ehError && <p className="notice error" role="status">{selected.ehError}</p>}
                </section>
                <section className="editor-section">
                  <h3>Personal details {draft.dirty && <span className="status">Unsaved changes</span>}</h3>
                  <label className="field"><span>Custom title</span><input value={draft.customTitle} disabled={savingEntryId === draft.entryId} onChange={(event) => setDraft(updateEntryDraft(draft, { customTitle: event.target.value }))} placeholder="Use source title when empty" /></label>
                  <label className="field"><span>Note</span><textarea rows={4} value={draft.note} disabled={savingEntryId === draft.entryId} onChange={(event) => setDraft(updateEntryDraft(draft, { note: event.target.value }))} /></label>
                  <div className="field"><span>Tags</span><div className="chips">
                    {effectiveTagOrigins({ ehTags: selected.ehTags || [], localTags: draft.localTags, hiddenTags: draft.hiddenTags }).eh.map((tag) => <span className="tag-chip" key={`eh:${tag}`}>{tag}<button disabled={savingEntryId === draft.entryId} onClick={() => setDraft(updateEntryDraft(draft, { hiddenTags: [...draft.hiddenTags, tag] }))}>Hide</button></span>)}
                    {effectiveTagOrigins({ ehTags: selected.ehTags || [], localTags: draft.localTags, hiddenTags: draft.hiddenTags }).local.map((tag) => <span className="tag-chip" key={`local:${tag}`}>{tag}<button aria-label={`Remove ${tag}`} disabled={savingEntryId === draft.entryId} onClick={() => setDraft(updateEntryDraft(draft, { localTags: draft.localTags.filter((item) => item !== tag) }))}>×</button></span>)}
                    {draft.hiddenTags.map((tag) => <span className="tag-chip hidden-tag" key={`hidden:${tag}`}>{tag}<button disabled={savingEntryId === draft.entryId} onClick={() => setDraft(updateEntryDraft(draft, { hiddenTags: draft.hiddenTags.filter((item) => item !== tag) }))}>Restore</button></span>)}
                  </div></div>
                  <div className="row"><input list="tag-suggestions" aria-label="Add personal tag" placeholder="Add personal tag" value={editTag} disabled={savingEntryId === draft.entryId} onChange={(event) => setEditTag(event.target.value)} onKeyDown={(event) => { if (isComposingEnter(event.key, event.nativeEvent.isComposing, event.nativeEvent.keyCode)) return; if (event.key === 'Enter' && editTag.trim()) { event.preventDefault(); const tag = editTag.trim(); if (!draft.localTags.includes(tag)) setDraft(updateEntryDraft(draft, { localTags: [...draft.localTags, tag] })); setEditTag(''); } }} /><button disabled={savingEntryId === draft.entryId} onClick={() => { const tag = editTag.trim(); if (tag && !draft.localTags.includes(tag)) setDraft(updateEntryDraft(draft, { localTags: [...draft.localTags, tag] })); setEditTag(''); }}>Add local tag</button></div>
                  <div className="row"><button className="primary" disabled={!draft.dirty || savingEntryId === draft.entryId} onClick={() => void saveEntry()}>Save</button><button disabled={!draft.dirty || savingEntryId === draft.entryId} onClick={() => setDraft(entryDraft(selected))}>Discard</button></div>
                </section>
                <div className="row">
                  <select
                    value={readerId}
                    onChange={(event) => setReaderId(event.target.value)}
                  >
                    <option value="">Default reader</option>
                    {config.readers.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                  <button className="primary" onClick={() => void openEntry(selected)}>
                    Open
                  </button>
                  <button onClick={() => { if (!confirmDraftDiscard()) return; selectionGeneration.current += 1; selectedEntryIdRef.current = null; setSelected(null); setDraft(null); setSavingEntryId(null); }}>Close</button>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {tab === 'Roots & Scans' && (
        <main className="content">
          <section className="section">
            <h2>Server roots</h2>
            {roots.map((root) => (
              <div className="scan" key={root.id}>
                <div className="row">
                  <strong>{root.label}</strong>
                  <span className="muted">{root.serverPath}</span>
                  <button
                    onClick={() =>
                      setRootEdit({
                        id: root.id,
                        label: root.label,
                        exclusions: root.exclusions.join(', '),
                      })
                    }
                  >
                    Edit
                  </button>
                  <button onClick={() => void startScan(root.id)}>Scan now</button>
                  <button className="danger" onClick={() => void removeRoot(root)}>
                    Remove
                  </button>
                </div>
                <div className="muted">
                  Exclusions: {root.exclusions.join(', ') || 'None'}
                </div>
                {rootEdit?.id === root.id && (
                  <div className="form-grid">
                    <Field
                      label="Label"
                      value={rootEdit.label}
                      set={(label) => setRootEdit({ ...rootEdit, label })}
                    />
                    <Field
                      label="Excluded folders (comma separated)"
                      value={rootEdit.exclusions}
                      set={(exclusions) =>
                        setRootEdit({ ...rootEdit, exclusions })
                      }
                    />
                    <div className="row">
                      <button className="primary" onClick={() => void saveRootEdit()}>
                        Save changes
                      </button>
                      <button onClick={() => setRootEdit(null)}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="form">
            <h2>Add a server root</h2>
            <div className="form-grid">
              <Field
                label="Label"
                value={newRoot.label}
                set={(value) => setNewRoot({ ...newRoot, label: value })}
              />
              <Field
                label="Server path"
                value={newRoot.serverPath}
                set={(value) => setNewRoot({ ...newRoot, serverPath: value })}
              />
              <Field
                label="Excluded folders (comma separated)"
                value={newRoot.exclusions}
                set={(value) => setNewRoot({ ...newRoot, exclusions: value })}
              />
            </div>
            <button className="primary" onClick={() => void addRoot()}>
              Add root
            </button>
          </section>

          <section className="section">
            <h2>Recent scans</h2>
            {scans.length === 0 ? (
              <p className="muted">No scans yet.</p>
            ) : (
              scans.map((scanItem) => (
                <div className="scan" key={scanItem.id}>
                  <strong>
                    {roots.find((root) => root.id === scanItem.rootId)?.label ??
                      scanItem.rootId}
                  </strong>{' '}
                  <span className="status">{scanItem.status}</span>
                  <div className="muted">
                    Found {scanItem.found} · Indexed {scanItem.indexed} · Errors{' '}
                    {scanErrorCount(scanItem.errors)}
                  </div>
                  {scanErrorCount(scanItem.errors) > 0 && (
                    Array.isArray(scanItem.errors) ? (
                      <ul className="muted">
                        {scanItem.errors.map((scanError, index) => (
                          <li key={`${index}-${scanError}`}>{scanError}</li>
                        ))}
                      </ul>
                    ) : null
                  )}
                </div>
              ))
            )}
          </section>
        </main>
      )}

      {tab === 'Settings' && (
        <main className="content">
          <section className="form">
            <h2>Server connection</h2>
            <div className="form-grid">
              <Field
                label="Server URL"
                value={connectionUrl}
                set={setConnectionUrl}
                placeholder="http://127.0.0.1:4317"
              />
              <Field
                label="Bearer token"
                type="password"
                value={token}
                set={setToken}
                placeholder={
                  config.connection.tokenConfigured
                    ? 'Saved; enter a new token to replace'
                    : 'Enter token'
                }
              />
            </div>
            <div className="row">
              <button className="primary" onClick={() => void testConnection()}>
                Save and test connection
              </button>
              {health && <span className="muted">{health}</span>}
            </div>
          </section>

          <section className="form">
            <h2>E-Hentai / ExHentai lookup</h2>
            <label className="field"><span>Default site</span><select value={ehSettings.site} onChange={(event) => setEhSettings({ ...ehSettings, site: event.target.value as EhSettings['site'] })}><option value="e-hentai.org">e-hentai.org</option><option value="exhentai.org">exhentai.org</option></select></label>
            <label className="field"><span>Preferred language</span><input value={ehSettings.language} onChange={(event) => setEhSettings({ ...ehSettings, language: event.target.value })} placeholder="Any language" /></label>
            <div className="setting-options">
              <label><input type="checkbox" checked={ehSettings.useThumbnails} onChange={(event) => setEhSettings({ ...ehSettings, useThumbnails: event.target.checked })} /> Try cover search first, then fall back to title</label>
              <label><input type="checkbox" checked={ehSettings.searchGid} onChange={(event) => setEhSettings({ ...ehSettings, searchGid: event.target.checked })} /> Use a bracketed filename number as gallery ID</label>
              <label><input type="checkbox" checked={ehSettings.includeExpunged} onChange={(event) => setEhSettings({ ...ehSettings, includeExpunged: event.target.checked })} /> Include expunged galleries</label>
              <label><input type="checkbox" checked={ehSettings.preferOriginalTitle} onChange={(event) => setEhSettings({ ...ehSettings, preferOriginalTitle: event.target.checked })} /> Prefer the original gallery title</label>
              <label><input type="checkbox" checked={ehSettings.additionalTags} onChange={(event) => setEhSettings({ ...ehSettings, additionalTags: event.target.checked })} /> Include uploader and upload time</label>
            </div>
            <label className="field"><span>Wait between books in a batch (seconds)</span><input type="number" min={0} max={20} step={1} value={ehSettings.interval} onChange={(event) => setEhSettings({ ...ehSettings, interval: event.target.value === '' ? 0 : Number(event.target.value) })} /></label>
            <p className="muted">Credentials: {ehSettings.credentialsConfigured ? 'Configured' : 'Not configured'}</p>
            <label className="field"><span>Named EH login cookies</span><input type="password" autoComplete="new-password" value={ehCookieHeader} onChange={(event) => setEhCookieHeader(event.target.value)} placeholder="Paste the server-supported name=value cookies" /></label>
            <label><input type="checkbox" checked={ehSettings.sendCookiesToEHentai} onChange={(event) => setEhSettings({ ...ehSettings, sendCookiesToEHentai: event.target.checked })} /> Send configured cookies to public e-hentai.org searches</label>
            <p className="muted">This opt-in applies only to searches on e-hentai.org. Cookies are write-only and are never returned to the desktop.</p>
            <div className="row"><button className="primary" onClick={() => void saveEhSettings()}>Save lookup settings</button><button disabled={!ehSettings.credentialsConfigured} onClick={() => void saveEhSettings(true)}>Clear credentials</button>{ehSettingsMessage && <span className="muted" role="status">{ehSettingsMessage}</span>}</div>
          </section>

          <section className="form">
            <h2>Database backup and restore</h2>
            <p className="muted">
              Use the server CLI: <code>henshin-server backup --data-dir &lt;dir&gt; --out &lt;file.sqlite&gt;</code> works while the server is running or stopped. Restore with <code>henshin-server restore --data-dir &lt;dir&gt; --in &lt;file.sqlite&gt;</code> only while the server is stopped. Restore keeps the previous database and WAL/SHM files in a <code>pre-restore-*</code> folder and clears covers for regeneration.
            </p>
            <p className="muted">
              <strong>Included:</strong> the application database (roots, entries, E-Hentai metadata and tags, personal titles, notes, tag overrides, and open history). <strong>Outside this backup:</strong> original comic files on the NAS, server secrets and ExHentai credentials, this device’s <code>desktop-config.json</code>, and the regenerable cover cache.
            </p>
          </section>

          <section className="form">
            <h2>Local root mappings</h2>
            {roots.length === 0 ? (
              <p className="muted">Connect to the server to load roots.</p>
            ) : (
              roots.map((root) => (
                <div className="row scan" key={root.id}>
                  <strong style={{ minWidth: 140 }}>{root.label}</strong>
                  <span className="muted" style={{ flex: 1 }}>
                    {config.mappings[root.id] || 'Not mapped'}
                  </span>
                  <button onClick={() => void chooseLocalFolder(root.id)}>
                    Choose local folder
                  </button>
                </div>
              ))
            )}
          </section>

          <section className="form">
            <div className="row">
              <h2 style={{ flex: 1 }}>External readers</h2>
              <button onClick={addReader}>Add reader</button>
            </div>
            {config.readers.map((candidate) => (
              <div className="scan row" key={candidate.id}>
                <span>
                  <strong>{candidate.name}</strong>
                  {candidate.isDefault && <span className="status"> Default</span>}
                </span>
                <button
                  onClick={() => {
                    setReader(candidate);
                    setReaderArgs(candidate.args.join('\n'));
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() =>
                    void saveReaderList(
                      config.readers.filter((item) => item.id !== candidate.id),
                    )
                  }
                >
                  Delete
                </button>
                <button
                  onClick={() =>
                    void saveReaderList(
                      config.readers.map((item) => ({
                        ...item,
                        isDefault: item.id === candidate.id,
                      })),
                    )
                  }
                >
                  Set default
                </button>
              </div>
            ))}

            <div className="form-grid">
              <Field
                label="Reader name"
                value={reader.name}
                set={(name) => setReader({ ...reader, name })}
              />
              <label className="field">
                <span>Mode</span>
                <select
                  value={reader.mode}
                  onChange={(event) =>
                    setReader({
                      ...reader,
                      mode: event.target.value as Reader['mode'],
                    })
                  }
                >
                  <option value="executable">Executable</option>
                  <option value="system">System default app</option>
                </select>
              </label>
            </div>

            {reader.mode === 'executable' && (
              <>
                <div className="row">
                  <label className="field">
                    <span>Executable path</span>
                    <input
                      value={reader.executable || ''}
                      onChange={(event) =>
                        setReader({ ...reader, executable: event.target.value })
                      }
                    />
                  </label>
                  <button
                    onClick={async () => {
                      const executable = await window.henshin.chooseExecutable();
                      if (executable) setReader({ ...reader, executable });
                    }}
                  >
                    Choose executable
                  </button>
                </div>
                <label className="field">
                  <span>Arguments (one per line; file path is appended)</span>
                  <textarea
                    rows={3}
                    value={readerArgs}
                    onChange={(event) => setReaderArgs(event.target.value)}
                  />
                </label>
              </>
            )}

            <label className="row">
              <input
                type="checkbox"
                checked={reader.isDefault}
                onChange={(event) =>
                  setReader({ ...reader, isDefault: event.target.checked })
                }
              />
              Use as default reader
            </label>
            <button className="primary" onClick={() => void saveReader()}>
              Save reader
            </button>
          </section>
        </main>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  set,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string;
  set: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => set(event.target.value)}
      />
    </label>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
