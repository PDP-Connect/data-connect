# macOS Node helper

The release finalizer and local production build move the Tauri `pdpp-node`
sidecar to `Contents/Helpers/DataConnect Helper.app/Contents/MacOS/DataConnect`.
The helper has bundle ID `dev.dataconnect.node`, display name `DataConnect`, and
`LSBackgroundOnly=true`. All desktop Node launches resolve this executable;
Node children inherit it through `process.execPath`.

[libuv 1.52.1](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/darwin-proctitle.c#L60-L150)
checks into LaunchServices with the main bundle's Info.plist when JavaScript sets
`process.title`. There is no environment or flag bypass in that implementation.
Next sets the title in its standalone server. The reference server source does
not set it. A preload that replaces the setter would suppress this trigger but
would need to reach every Node entry point and child. An activation-policy change
after launch could allow an initial Dock bounce. The nested bundle supplies the
background identity at check-in, including for future title-setting dependencies.

Do not leave a symlink at `Contents/MacOS/pdpp-node`: the macOS probe registered
that invocation as Foreground under the outer bundle ID even though
`process.execPath` resolved to the helper. Direct helper invocation registered as
BackgroundOnly under `dev.dataconnect.node`.

## Downstream signer prerequisite

Before signing a release with this layout, update `classify_executable` in
`vana-com/unity-surfaces/.github/workflows/sign-dataconnect-release.yml`:

```bash
"Contents/Helpers/DataConnect Helper.app/Contents/MacOS/DataConnect") echo node ;;
```

Replace the old `Contents/MacOS/pdpp-node` rule, or retain both while supporting
older releases. Keep the Node entitlements on the helper bundle's main executable.
The signer's existing deepest-first bundle plan signs the helper before the outer
app and derives its entitlement class from this path. Without the new rule, the
signer rejects the executable as unclassified.

The artifact verifier now requires the nested executable and its background-only
plist, rejects the old foreground path, and checks the helper architecture.
Developer ID signing and Apple notarization require the downstream signing run.
