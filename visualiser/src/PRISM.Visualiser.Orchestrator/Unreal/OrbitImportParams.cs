namespace PRISM.Visualiser.Orchestrator.Unreal;

/// <summary>
/// ORBIT model coordinates handed to a <c>-game</c> UE process so the bundled
/// <c>OrbitConnector.UE5</c> plug-in can pull + load the model itself
/// (headless, on the game world's BeginPlay) instead of the orchestrator
/// staging glTF and importing via the Interchange python path.
///
/// <para>
/// The launcher turns these into the connector's command-line tokens
/// (<c>-OrbitServer= -OrbitProject= -OrbitModel= -OrbitVersion= -OrbitToken=
/// -OrbitTarget=</c>) that <c>FOrbitHeadlessAutoImport</c> reads. The token is
/// passed on the command line because the connector's <c>orbit-cli</c> reads it
/// from there (or from <c>ORBIT_TOKEN</c>); it is never logged.
/// </para>
/// </summary>
/// <param name="Server">ORBIT environment selector: <c>prod</c>, <c>dev</c>, or an explicit https URL.</param>
/// <param name="ProjectId">ORBIT project id.</param>
/// <param name="ModelId">ORBIT model id.</param>
/// <param name="VersionId">ORBIT version id; empty = latest.</param>
/// <param name="Token">Bearer PAT; empty = rely on a cached CLI login / ORBIT_TOKEN.</param>
/// <param name="Target">Optional caller-defined target tag (forwarded, currently informational).</param>
public sealed record OrbitImportParams(
    string Server,
    string ProjectId,
    string ModelId,
    string VersionId,
    string Token,
    string Target = "");
