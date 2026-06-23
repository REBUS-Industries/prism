using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace PRISM.Agent.Rhino;

/// <summary>
/// Headless convert preflight — remove geometry the Orbit Rhino connector
/// cannot mesh. Some imported curves (often on construction/helper layers)
/// make <see cref="Curve.GetLength"/> throw a native SEH fault inside
/// OrbitConnector.RhinoObjectMeshes.ExtractFromCurve, failing the whole job.
/// </summary>
public static class RhinoConvertPreflight
{
    /// <summary>
    /// Delete curve objects whose length cannot be evaluated. Returns count removed.
    /// </summary>
    public static int RemoveUnmeshableCurves(RhinoDoc doc, Action<string>? log = null)
    {
        var toDelete = new List<Guid>();
        foreach (var obj in doc.Objects)
        {
            if (obj.Geometry is not Curve curve) continue;
            if (TryValidateCurve(curve)) continue;

            var layerPath = ResolveLayerPath(doc, obj);
            log?.Invoke(
                $"[ORBIT-PREFLIGHT] removing curve id={obj.Id} layer='{layerPath}' " +
                "(GetLength failed or curve is invalid/degenerate)");
            toDelete.Add(obj.Id);
        }

        foreach (var id in toDelete)
            doc.Objects.Delete(id, quiet: true);

        return toDelete.Count;
    }

    static string ResolveLayerPath(RhinoDoc doc, RhinoObject obj)
    {
        try
        {
            var idx = obj.Attributes.LayerIndex;
            if (idx < 0 || idx >= doc.Layers.Count) return "?";
            var layer = doc.Layers[idx];
            if (layer is null || layer.IsDeleted) return "?";
            return string.IsNullOrEmpty(layer.FullPath) ? layer.Name : layer.FullPath;
        }
        catch
        {
            return "?";
        }
    }

    static bool TryValidateCurve(Curve curve)
    {
        try
        {
            if (!curve.IsValid) return false;
            // Same call path that faults in OrbitConnector.RhinoObjectMeshes.ExtractFromCurve.
            _ = curve.GetLength();
            return true;
        }
        catch
        {
            return false;
        }
    }
}
