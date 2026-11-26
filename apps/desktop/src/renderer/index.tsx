import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

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
  lastOpenedAt?: number;
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
  errors: number;
};

const effectiveTitle = (entry: Entry) =>
  entry.customTitle || entry.ehTitleJpn || entry.ehTitle || entry.title;

const formatTimestamp = (seconds?: number) =>
  seconds ? new Date(seconds * 1000).toLocaleString() : 'Never';

const emptyConfig: Config = {
  connection: { url: '', tokenConfigured: false },
  mappings: {},
  readers: [],
};

function App() {
  const [tab, setTab] = useState<View>('Library');
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [token, setToken] = useState('');
  const [health, setHealth] = useState('');
  const [roots, setRoots] = useState<Root[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [rootId, setRootId] = useState('');
  const [status, setStatus] = useState('active');
  const [readerId, setReaderId] = useState('');
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
    setConfig(saved);
    setToken('');
    return saved;
  };

  const refresh = async () => {
    setError('');
    try {
      const rootQuery = rootId ? `&rootId=${encodeURIComponent(rootId)}` : '';
      const [rootResult, entryResult, scanResult] = await Promise.all([
        call<{ roots: Root[] }>('/api/roots'),
        call<{ entries: Entry[] }>(
          `/api/entries?status=${status}${rootQuery}&limit=500`,
        ),
        call<{ scans: Scan[] }>('/api/scans'),
      ]);
      setRoots(rootResult.roots);
      setEntries(entryResult.entries);
      setScans(scanResult.scans);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  useEffect(() => {
    window.henshin.getConfig().then((savedConfig: Config) => {
      setConfig(savedConfig);
      const defaultReader =
        savedConfig.readers.find((candidate) => candidate.isDefault) ??
        savedConfig.readers[0];
      if (defaultReader) setReader(defaultReader);
    });
  }, []);

  useEffect(() => {
    if (config.connection.url) void refresh();
  }, [config.connection.url, status, rootId]);

  useEffect(() => {
    const hasRunningScan = scans.some((scanItem) => scanItem.status === 'running');
    if (!hasRunningScan) return;

    const timer = setInterval(() => void refresh(), 1300);
    return () => clearInterval(timer);
  }, [scans]);

  const testConnection = async () => {
    setError('');
    try {
      const savedConfig = await saveConnection(config, token);
      const result = await call<{ serverId: string; version: string }>(
        '/api/health',
      );
      setHealth(`Connected to ${result.serverId} · v${result.version}`);
      setNotice('Connection tested successfully.');
      setConfig(savedConfig);
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
      await refresh();
      const refreshedEntry = await call<Entry>(
        `/api/entries/${encodeURIComponent(entry.id)}`,
      );
      setSelected(refreshedEntry);
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
    const folder = await window.henshin.chooseDirectory();
    if (!folder) return;

    const mappings = await window.henshin.mapRoot(id, folder);
    setConfig({ ...config, mappings });
  };

  const saveReaderList = async (readers: Reader[]) => {
    await window.henshin.saveReaders(readers);
    setConfig({ ...config, readers });
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

  return (
    <div className="shell">
      <header className="header">
        <div className="brand">Henshin</div>
        <nav className="nav">
          {(['Library', 'Roots & Scans', 'Settings'] as const).map((view) => (
            <button
              key={view}
              className={tab === view ? 'active' : ''}
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
          <div className="toolbar">
            <select value={rootId} onChange={(event) => setRootId(event.target.value)}>
              <option value="">All roots</option>
              {roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.label}
                </option>
              ))}
            </select>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="active">Active</option>
              <option value="missing">Missing</option>
            </select>
            <button onClick={() => void refresh()}>Refresh</button>
          </div>

          {!config.connection.url ? (
            <div className="empty">
              Connect to your Henshin server in Settings to load your library.
            </div>
          ) : entries.length === 0 ? (
            <div className="empty">
              No entries found. Add a root and scan it under Roots &amp; Scans.
            </div>
          ) : (
            <div className="grid">
              {entries.map((entry) => (
                <article
                  className="card"
                  key={entry.id}
                  onClick={() => {
                    setSelected(entry);
                    setReaderId('');
                  }}
                >
                  <img
                    src={
                      entry.coverKey
                        ? `henshin-cover://${encodeURIComponent(entry.coverKey)}`
                        : ''
                    }
                    alt=""
                  />
                  <div className="meta">
                    <h3>{effectiveTitle(entry)}</h3>
                    <div className="muted">
                      {entry.pageCount} pages · Opened {entry.openCount}×
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {selected && (
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
                <h2>{effectiveTitle(selected)}</h2>
                <div className="muted">{selected.relativePath}</div>
                <p>
                  {selected.pageCount} pages · Opened {selected.openCount}× · Last
                  opened {formatTimestamp(selected.lastOpenedAt)}
                </p>
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
                  <button onClick={() => setSelected(null)}>Close</button>
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
                    {scanItem.errors}
                  </div>
                  {scanItem.errors > 0 && (
                    <div className="muted">
                      Some files could not be indexed; see server logs for details.
                    </div>
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
                value={config.connection.url}
                set={(url) =>
                  setConfig({
                    ...config,
                    connection: { ...config.connection, url },
                  })
                }
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
                  <div className="field">
                    <label>Executable path</label>
                    <input
                      value={reader.executable || ''}
                      onChange={(event) =>
                        setReader({ ...reader, executable: event.target.value })
                      }
                    />
                  </div>
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
