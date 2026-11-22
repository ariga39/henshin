import { useEffect, useState } from "react"
import type {
  ReaderEntryFormat,
  ReaderLaunchMode,
  ReaderProfile,
  ReaderProfileSaveIpcRequest,
  ReaderTargetMode
} from "@henshin/contracts"
import { runtime } from "./runtime"
import { viewStore } from "./store"
import {
  clearReaderExecutableSelection,
  loadReaderProfiles,
  saveReaderProfile,
  selectReaderExecutable
} from "./workflows"
import { useSyncExternalStore } from "react"

interface ProfileDraft {
  readonly profile_id: string | null
  readonly expected_revision: string
  readonly name: string
  readonly launch_mode: ReaderLaunchMode
  readonly supported_formats: ReadonlyArray<ReaderEntryFormat>
  readonly target_mode: ReaderTargetMode
  readonly argument_tokens: ReadonlyArray<string>
  readonly executable_name: string | null
}

const emptyDraft = (): ProfileDraft => ({
  profile_id: null,
  expected_revision: "0",
  name: "",
  launch_mode: "explicit-executable",
  supported_formats: ["archive"],
  target_mode: "archive",
  argument_tokens: ["{target}"],
  executable_name: null
})

const draftFor = (profile: ReaderProfile): ProfileDraft => ({
  profile_id: profile.profile_id,
  expected_revision: profile.revision,
  name: profile.name,
  launch_mode: profile.launch_mode,
  supported_formats: profile.supported_formats,
  target_mode: profile.target_mode,
  argument_tokens: profile.argument_tokens,
  executable_name: profile.executable_name
})

const formatLabel = (format: ReaderEntryFormat): string =>
  format === "archive" ? "ZIP/CBZ archive" : "image directory"

const launchModeLabel = (mode: ReaderLaunchMode): string =>
  mode === "explicit-executable" ? "Explicit executable" : "System association"

const targetModeLabel = (mode: ReaderTargetMode): string =>
  mode === "archive" ? "Archive" : mode === "directory" ? "Directory" : "First image"

export const ReaderProfiles = () => {
  const state = useSyncExternalStore(viewStore.subscribe, viewStore.getState)
  const [draft, setDraft] = useState<ProfileDraft>(emptyDraft)

  useEffect(() => {
    void runtime.runPromise(loadReaderProfiles)
  }, [])

  const update = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const toggleFormat = (format: ReaderEntryFormat): void => {
    const formats = draft.supported_formats.includes(format)
      ? draft.supported_formats.filter((candidate) => candidate !== format)
      : [...draft.supported_formats, format]
    update("supported_formats", formats)
  }

  const edit = (profile: ReaderProfile): void => {
    clearReaderExecutableSelection()
    setDraft(draftFor(profile))
  }

  const startNew = (): void => {
    clearReaderExecutableSelection()
    setDraft(emptyDraft())
  }

  const save = async (): Promise<void> => {
    const selectionHandle = viewStore.getState().reader_profile_selection_handle
    const saved = await runtime.runPromise(saveReaderProfile({
      profile_id: draft.profile_id,
      expected_revision: draft.expected_revision,
      name: draft.name,
      launch_mode: draft.launch_mode,
      supported_formats: draft.supported_formats,
      target_mode: draft.target_mode,
      argument_tokens: draft.launch_mode === "system-association" ? [] : draft.argument_tokens,
      selection_handle: selectionHandle
    } satisfies ReaderProfileSaveIpcRequest))
    if (saved !== undefined) setDraft(emptyDraft())
  }

  const selectedExecutable = state.reader_profile_selection_name ?? draft.executable_name
  const saving = state.reader_profile_save_status === "loading"
  return (
    <section aria-labelledby="reader-settings-heading" data-testid="reader-settings">
      <h2 id="reader-settings-heading">This device: reader profiles</h2>
      <p>
        Reader profiles are stored only on this desktop. Saving a profile never opens an application or records history.
      </p>
      {state.reader_profiles_status === "loading" && <p>Loading reader profiles…</p>}
      {state.reader_profiles_status === "error" && <p role="alert">Could not load reader profiles: {state.reader_profiles_error}</p>}
      <ul data-testid="reader-profile-list">
        {state.reader_profiles.map((profile) => (
          <li key={profile.profile_id} data-testid={`reader-profile-${profile.profile_id}`}>
            <strong>{profile.name}</strong> (revision {profile.revision})
            <span> · {launchModeLabel(profile.launch_mode)} · {targetModeLabel(profile.target_mode)} · </span>
            <span>{profile.supported_formats.map(formatLabel).join(", ")}</span>
            {profile.executable_name !== null && <span> · executable: {profile.executable_name}</span>}
            {profile.argument_tokens.length > 0 && (
              <ol aria-label={`${profile.name} argument tokens`}>
                {profile.argument_tokens.map((token, index) => <li key={`${index}-${token}`}>{token}</li>)}
              </ol>
            )}
            <button type="button" onClick={() => edit(profile)}>Edit</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => { event.preventDefault(); if (!saving) void save() }}>
        <h3>{draft.profile_id === null ? "New reader profile" : `Edit ${draft.name}`}</h3>
        <label htmlFor="reader-profile-name">Name</label>
        <input
          id="reader-profile-name"
          data-testid="reader-profile-name"
          value={draft.name}
          disabled={saving}
          onChange={(event) => update("name", event.target.value)}
        />

        <label htmlFor="reader-profile-launch-mode">Launch mode</label>
        <select
          id="reader-profile-launch-mode"
          data-testid="reader-profile-launch-mode"
          value={draft.launch_mode}
          disabled={saving}
          onChange={(event) => {
            const mode = event.target.value as ReaderLaunchMode
            update("launch_mode", mode)
            if (mode === "system-association") clearReaderExecutableSelection()
          }}
        >
          <option value="explicit-executable">Explicit executable</option>
          <option value="system-association">System association</option>
        </select>

        <fieldset>
          <legend>Supported entry formats</legend>
          {(["archive", "image-directory"] as const).map((format) => (
            <label key={format}>
              <input
                type="checkbox"
                data-testid={`reader-format-${format}`}
                checked={draft.supported_formats.includes(format)}
                disabled={saving}
                onChange={() => toggleFormat(format)}
              />
              {formatLabel(format)}
            </label>
          ))}
        </fieldset>

        <label htmlFor="reader-profile-target-mode">Target mode</label>
        <select
          id="reader-profile-target-mode"
          data-testid="reader-profile-target-mode"
          value={draft.target_mode}
          disabled={saving}
          onChange={(event) => update("target_mode", event.target.value as ReaderTargetMode)}
        >
          <option value="archive">Archive itself</option>
          <option value="directory">Image-directory root</option>
          <option value="first-image">First image (directories only)</option>
        </select>

        {draft.launch_mode === "explicit-executable" ? (
          <>
            <button type="button" data-testid="reader-select-executable" disabled={saving} onClick={() => void runtime.runPromise(selectReaderExecutable)}>
              Choose executable…
            </button>
            <span data-testid="reader-selected-executable">{selectedExecutable ?? "No executable selected"}</span>
            <label htmlFor="reader-profile-arguments">Argument tokens (one token per line)</label>
            <textarea
              id="reader-profile-arguments"
              data-testid="reader-profile-arguments"
              value={draft.argument_tokens.join("\n")}
              disabled={saving}
              onChange={(event) => update("argument_tokens", event.target.value.split("\n"))}
            />
            <small>The tokens must contain exactly one whole {"{target}"} placeholder.</small>
          </>
        ) : (
          <p>System association uses the operating system's association for the checked target; it accepts no argument tokens.</p>
        )}
        {(state.reader_profile_selection_error !== null || state.reader_profile_save_error !== null) && (
          <p role="alert" data-testid="reader-profile-error">
            {state.reader_profile_selection_error ?? state.reader_profile_save_error}
          </p>
        )}
        <button type="submit" data-testid="reader-profile-save" disabled={saving}>
          {saving ? "Saving…" : "Save reader profile"}
        </button>
        <button type="button" disabled={saving} onClick={startNew}>New profile</button>
      </form>
    </section>
  )
}
