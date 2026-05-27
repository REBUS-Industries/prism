# PRISM Visualiser changelog

The orchestrator versions independently of the PRISM Agent. The bump is
`Directory.Build.props::VisualiserVersion`; the CI tag convention is
`visualiser-v<VisualiserVersion>`.

## v0.1.0 — Phase B scaffold

- System.CommandLine CLI with `stream` + `cache` subcommands
- `--dry-run` emits a syntactically valid `prism-visualiser/ready/v1`
  JSON event on stdout
- Job Object self-assignment with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  for child-process supervision (Cirrus / UE land in Phase E/F)
- Structured logging via Serilog: console sink to stderr at Information,
  rolling file sink at Verbose under
  `%LOCALAPPDATA%\PRISM.Visualiser\runs\<runId>\logs\orchestrator.log`
- Content-addressed cache directory resolution under
  `%LOCALAPPDATA%\PRISM.Visualiser\cache\{objects,blobs,stage}`
  (no actual fetch / eviction yet)
- xUnit test project with `ReadyHandshakeTests` locking the on-wire
  JSON shape down field-by-field
