namespace PRISM.Visualiser.Orchestrator.Unreal;

/// <summary>
/// External "Portal" connection the Unreal plug-ins authenticate against.
/// Forwarded from the PRISM agent via the <c>PRISM_PORTAL_URL</c> /
/// <c>PRISM_REBUS_API_KEY</c> env vars and turned by
/// <see cref="UnrealLauncher"/> into the UE command-line tokens
/// <c>-PortalUrl="&lt;url&gt;"</c> and <c>-RebusApiKey=&lt;key&gt;</c>.
///
/// <para>
/// <see cref="ApiKey"/> is a SECRET: it is passed to UE on the command line
/// only (so the plug-in / Portal client reads it from there) and is NEVER
/// logged — exactly mirroring the existing <c>-OrbitToken=</c> handling
/// (see <see cref="OrbitImportParams"/>). <see cref="Url"/> is not secret and
/// may be logged normally.
/// </para>
/// </summary>
/// <param name="Url">Portal base URL, e.g. <c>https://app.rebus.industries</c>. Empty = unset.</param>
/// <param name="ApiKey">REBUS Portal API key. Empty = unset (the launcher omits the flag).</param>
public sealed record PortalSettings(string Url, string ApiKey)
{
    /// <summary>Env var carrying the Portal base URL (NOT secret).</summary>
    public const string UrlEnvVar = "PRISM_PORTAL_URL";

    /// <summary>Env var carrying the REBUS Portal API key (SECRET — never logged).</summary>
    public const string ApiKeyEnvVar = "PRISM_REBUS_API_KEY";

    /// <summary>True when an API key is present (the only field safe to log).</summary>
    public bool HasApiKey => !string.IsNullOrWhiteSpace(ApiKey);

    /// <summary>True when a Portal URL is present.</summary>
    public bool HasUrl => !string.IsNullOrWhiteSpace(Url);

    /// <summary>
    /// True when there is anything to forward to UE at all. When false the
    /// caller can skip the launcher's Portal plumbing entirely.
    /// </summary>
    public bool IsEmpty => !HasUrl && !HasApiKey;

    /// <summary>
    /// Read the Portal settings from the orchestrator's environment (set by
    /// the PRISM agent when it spawns this process). Returns <c>null</c> when
    /// neither var is set, so the launcher omits both flags.
    /// </summary>
    public static PortalSettings? FromEnvironment(Func<string, string?>? readEnv = null)
    {
        readEnv ??= Environment.GetEnvironmentVariable;
        var url = readEnv(UrlEnvVar)?.Trim() ?? string.Empty;
        var key = readEnv(ApiKeyEnvVar)?.Trim() ?? string.Empty;
        if (url.Length == 0 && key.Length == 0) return null;
        return new PortalSettings(url, key);
    }
}
