namespace PRISM.Visualiser.Orchestrator.Models;

/// <summary>
/// ORBIT environment endpoints the orchestrator can target.
/// Phase B keeps the URLs as empty placeholders so the CLI surface
/// compiles and round-trips through <see cref="RunManifest"/> without
/// pretending to know real coordinates yet — Phase C / settings.json
/// loading will populate them.
/// </summary>
public sealed record ServerConfig(
    string GraphqlUrl,
    string BlobUrl,
    string Name)
{
    /// <summary>Empty stand-in for the production ORBIT server.</summary>
    public static ServerConfig EmptyProd { get; } = new(
        GraphqlUrl: string.Empty,
        BlobUrl: string.Empty,
        Name: "prod");

    /// <summary>Empty stand-in for the dev ORBIT server.</summary>
    public static ServerConfig EmptyDev { get; } = new(
        GraphqlUrl: string.Empty,
        BlobUrl: string.Empty,
        Name: "dev");

    /// <summary>Resolve a placeholder config for the given selector.</summary>
    public static ServerConfig Resolve(string selector) => selector switch
    {
        "prod" => EmptyProd,
        "dev" => EmptyDev,
        _ => throw new ArgumentException(
            $"Unknown server selector '{selector}'. Expected 'prod' or 'dev'.",
            nameof(selector)),
    };
}
