using global::Rhino;
using global::Rhino.FileIO;
using Microsoft.Extensions.Logging;

namespace PRISM.Agent.Rhino;

/// <summary>
/// Format-aware file loader. Knows which Rhino import strategy to use for
/// each supported extension.
///
/// Default strategy is <c>RhinoDoc.Read(path)</c> for native .3dm; everything
/// else is imported into a fresh doc using <see cref="FileImport"/> wrappers
/// and the format-specific import command.
/// </summary>
public sealed class RhinoFileOpener
{
    readonly ILogger<RhinoFileOpener> _log;

    public RhinoFileOpener(ILogger<RhinoFileOpener> log) { _log = log; }

    public static readonly IReadOnlyCollection<string> SupportedExtensions = new[]
    {
        ".3dm", ".dwg", ".dxf", ".fbx", ".obj", ".stl", ".ply",
        ".3mf", ".dae", ".step", ".stp", ".iges", ".igs",
    };

    public RhinoDoc OpenInto(RhinoHost host, string path, string formatHint)
    {
        var ext = string.IsNullOrEmpty(formatHint)
            ? Path.GetExtension(path).ToLowerInvariant()
            : formatHint.ToLowerInvariant();

        if (!SupportedExtensions.Contains(ext))
            throw new NotSupportedException($"format not supported by PRISM.Agent: {ext}");

        _log.LogInformation("opening {Path} as {Ext}", path, ext);

        if (ext == ".3dm")
        {
            var doc = RhinoDoc.OpenHeadless(path) ?? throw new IOException($"failed to open {path}");
            _log.LogInformation("opened {Path}: {ObjectCount} objects", path, doc.Objects.Count);
            return doc;
        }

        // Non-3dm path: create an empty doc and import.
        var target = host.CreateDoc();
        var ok = ImportFileInto(target, path, ext);
        if (!ok)
            throw new IOException($"Rhino refused to import {path} (format {ext})");
        _log.LogInformation("imported {Path}: {ObjectCount} objects", path, target.Objects.Count);
        return target;
    }

    static bool ImportFileInto(RhinoDoc doc, string path, string ext)
    {
        // RunScript with the canonical -_Import command. Quotes around the
        // path handle spaces; the trailing _Enter accepts default options.
        var quoted = "\"" + path + "\"";
        var script = $"-_Import {quoted} _Enter _Enter _Enter";

        try
        {
            return RhinoApp.RunScript(doc.RuntimeSerialNumber, script, false);
        }
        catch (Exception err)
        {
            global::Rhino.RhinoApp.WriteLine($"PRISM.Agent: import script threw: {err.Message}");
            return false;
        }
    }
}
