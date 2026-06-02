namespace PRISM.Visualiser.Orchestrator.Unreal;

/// <summary>
/// ORBIT session identity (project / model / version / server / target) handed
/// to the UE process so two consumers can read it:
/// <list type="number">
///   <item><description>
///     the bundled <c>OrbitConnector.UE5</c> plug-in's
///     <c>FOrbitHeadlessAutoImport</c>, which on the connector-import path pulls
///     + loads the model itself (headless, on the game world's BeginPlay)
///     instead of the orchestrator staging glTF + Interchange python; and
///   </description></item>
///   <item><description>
///     ANY other UE plugin/module (e.g. the Portal plugin) that wants the
///     project / model / version IDs as a UE-native shared variable.
///   </description></item>
/// </list>
///
/// <para>
/// The launcher turns these into the command-line tokens
/// (<c>-OrbitServer= -OrbitProject= -OrbitModel= -OrbitVersion= -OrbitToken=
/// -OrbitTarget=</c>) via <see cref="UnrealLauncher"/>'s <c>AppendOrbitArgs</c>.
/// The identity tokens are emitted on EVERY streaming launch path (connector,
/// Interchange, full-editor) so the IDs are always present; a plugin reads e.g.
/// the project id with
/// <c>FParse::Value(FCommandLine::Get(), TEXT("OrbitProject="), Out)</c>.
/// The bearer <see cref="Token"/> is emitted only when present (the
/// connector-import path) because the connector's <c>orbit-cli</c> reads it from
/// the command line (or from <c>ORBIT_TOKEN</c>); like a password it is NEVER
/// logged.
/// </para>
/// </summary>
/// <param name="Server">ORBIT environment selector: <c>prod</c>, <c>dev</c>, or an explicit https URL.</param>
/// <param name="ProjectId">ORBIT project id.</param>
/// <param name="ModelId">ORBIT model id.</param>
/// <param name="VersionId">ORBIT version id; empty = latest.</param>
/// <param name="Token">Bearer PAT; empty = identity-only (no token forwarded — non-connector paths).</param>
/// <param name="Target">Optional caller-defined target tag (forwarded, currently informational).</param>
public sealed record OrbitImportParams(
    string Server,
    string ProjectId,
    string ModelId,
    string VersionId,
    string Token,
    string Target = "");
