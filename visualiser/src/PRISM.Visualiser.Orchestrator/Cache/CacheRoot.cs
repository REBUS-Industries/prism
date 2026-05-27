namespace PRISM.Visualiser.Orchestrator.Cache;

/// <summary>
/// Resolves the content-addressed cache layout the orchestrator will
/// use to deduplicate ORBIT object + blob fetches across runs.
///
/// Phase B only creates the directory skeleton — Phase C+ fills the
/// folders with actual content. The layout is:
///
/// <code>
///   %LOCALAPPDATA%\PRISM.Visualiser\
///     cache\
///       objects\   ← ORBIT object JSON, keyed by object hash
///       blobs\     ← attachment blobs, keyed by content hash
///       stage\     ← per-run staging directory; pruned after import
/// </code>
///
/// Hidden behind a class so future moves (e.g. to a configurable
/// location read from a settings file) require no caller changes.
/// </summary>
public sealed class CacheRoot
{
    public string Root { get; }
    public string Objects { get; }
    public string Blobs { get; }
    public string Stage { get; }

    private CacheRoot(string root)
    {
        Root = root;
        Objects = Path.Combine(root, "objects");
        Blobs = Path.Combine(root, "blobs");
        Stage = Path.Combine(root, "stage");
    }

    /// <summary>
    /// Resolve the default cache root under <c>%LOCALAPPDATA%</c>. Does
    /// NOT create the directories — use <see cref="EnsureCreated"/>.
    /// </summary>
    public static CacheRoot ResolveDefault()
    {
        var local = Environment.GetFolderPath(
            Environment.SpecialFolder.LocalApplicationData,
            Environment.SpecialFolderOption.DoNotVerify);
        return new CacheRoot(Path.Combine(local, "PRISM.Visualiser", "cache"));
    }

    /// <summary>
    /// Resolve a cache root rooted at <paramref name="customRoot"/>.
    /// Used by tests and by a future <c>--cache-root</c> CLI flag.
    /// </summary>
    public static CacheRoot ResolveAt(string customRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(customRoot);
        return new CacheRoot(Path.Combine(customRoot, "cache"));
    }

    /// <summary>Create the cache sub-directories if missing.</summary>
    public CacheRoot EnsureCreated()
    {
        Directory.CreateDirectory(Objects);
        Directory.CreateDirectory(Blobs);
        Directory.CreateDirectory(Stage);
        return this;
    }

    public override string ToString() =>
        $"CacheRoot(root={Root}, objects={Objects}, blobs={Blobs}, stage={Stage})";
}
