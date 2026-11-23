# Session log with project

Adds **Session Log with Project** directly after **Download Session Log** in the current session’s top toolbar menu. The existing action is unchanged.

## Use

Open the session header’s **…** menu and select **Session Log with Project**. A status notice reports preparation or an error, then hands the download to the browser. The browser chooses the destination and reports progress and completion. Closing the notice does not cancel a browser download; repeated clicks during preparation share the same operation.

The ZIP contains:

- the normal DSH export: canonical session JSONL, descendant session logs and referenced attachments;
- **project/**: the session’s effective current working directory, including hidden files, Git data, ignored files and empty directories;
- **project-export-notes.txt**, when needed: symbolic links, junctions and special files which were not followed or copied.

There are no default exclusions for dependency folders or hidden files. A changed, disappeared or unreadable ordinary file fails the download rather than silently omitting it. The export reads files as bounded binary chunks and does not modify the source project. ZIP64 is selected automatically for large files, large archives and large file counts. Metadata grows with the number of archive entries; file payloads are not buffered in full.

**Before sharing:** project files may include credentials, private configuration or other sensitive data. A plain Markdown link in a conversation is not necessarily a stored attachment. Such a file is included through project/ only if it is inside the chosen project directory.

## Scope and limitations

- “Project” means the session’s current effective working directory, including a selected worktree or a directory set with the working-directory tool. It is not an inferred Git root, the process’s global cwd, or every workspace in the profile.
- Descendant logs are included, but unrelated project directories of descendants are not added.
- Export is a live filesystem read, not an atomic filesystem snapshot. Wait for active project writes to finish before exporting. Files are version-checked before and after reading.
- Directory enumeration may itself fail on an inaccessible linked target in the mounted filesystem provider; that also fails the download explicitly.
- HEAD preflight checks the root session and project directory. A later child-file or descendant read error appears in the browser’s download manager, just as for DSH’s native log export.
- Unix ownership, permission bits, timestamps, and link objects are not a backup format guarantee.

## Agent access

The deferred **session_log_with_project** tool creates the same combined archive as a stored file attachment and returns its host path when the attachment provider offers one. Its optional **sessionId** defaults to the calling session. UI and tool use one Host archive implementation; tool export does not open or manipulate the user’s browser.

## Implementation and installation

The bundle is installed through DSH Plugin Manager. Its authenticated exact **GET/HEAD /api/session.project-export?sessionId=…** route uses Connection’s existing access checks. The browser contributes a plain-data **sessionHeader** menu action at order 101, after the native export contribution at order 100; it does not replace the application shell or any shipped menu.

Session serialization, descendants and attachment traversal reuse the public **@deepseek-ai/dsh-session-log-export** API shipped with DSH **0.2.2-rc.3**. Project reads go through the composed filesystem and working-directory services, not direct host filesystem access. Package display metadata and status messages are supplied in English, Russian and Chinese; the requested menu name stays **Session Log with Project** in each language.

## Verification

Tests exercise ZIP contents, binary and Unicode fidelity, hidden/ignored/empty entries, no-follow behavior, effective working-directory selection, canonical logs and descendants, attachment export, identical UI/tool contents, HEAD behavior, sanitized failures, changed-file detection, cancellation, ZIP64 records, and real Windows reads through the installed LocalFileSystem provider. Browser rendering and a native download should also be checked in the connected GUI; a successful unit test is not visual verification.

## Third-party notices

The archive writer is based on **yazl 3.3.1**, copyright Josh Wolfe, MIT-licensed, with a local cancellation-cleanup patch. Its license is shipped with the vendored source. CRC-32 uses the MIT-licensed **buffer-crc32 1.0.0** package. The native browser download pattern follows DSH’s MIT-licensed session-log export; the folder/document icon is original artwork.
