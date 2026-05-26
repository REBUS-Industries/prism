using Rhino;
using Rhino.DocObjects;
using Rhino.Render;
using DocTexture = Rhino.DocObjects.Texture;

namespace PRISM.Agent.Rhino;

/// <summary>
/// Salvage materials/textures from sibling image files when a non-3dm importer
/// brought in geometry but zero materials.
///
/// <para>Motivating case: an FBX with externally-referenced JPG textures (e.g.
/// a Renderpeople character) uploaded as a .zip bundle. The agent extracts the
/// zip, <c>Rhino.FileIO.FileFbx.Read</c> reads the geometry + UVs perfectly,
/// but RhinoCommon's <c>FileFbxReadOptions</c> only exposes
/// <c>ImportCameras / ImportLights / ImportMeshesAsSubD / MapFbxYtoRhinoZ /
/// Unweld / UnweldAngle</c> — there is no material/texture import knob, and
/// the FBX writer has <c>SaveMaterialsAs</c> with no reader equivalent.
/// Net result: <c>doc.Materials.Count == 0</c> after the read, the
/// connector's three texture-extraction strategies (RDK / PBR / Bitmap) all
/// return null, and the ORBIT viewer renders the character in fallback grey.
/// The textures sit on disk one folder over but nothing references them.</para>
///
/// <para>This helper runs after every successful non-3dm import. If the doc
/// has objects but no materials, it scans the source file's directory tree
/// for image files, classifies them by filename-suffix heuristic (Renderpeople
/// / Substance / Megascans / generic PBR naming), and synthesises one
/// <c>PhysicallyBased</c> Rhino material. The material is assigned to every
/// imported object via <c>MaterialFromObject</c>. Downstream the existing
/// <c>RhinoMaterialHelper</c> picks up the textures via the PBR + Bitmap
/// strategies it already implements.</para>
///
/// <para>Scope: deliberately conservative. We only ever synthesise ONE material
/// applied to ALL objects. Real multi-material FBX (per-mesh materials) would
/// need an FBX parser. The single-material assumption holds for the dominant
/// use cases we see (character assets, single-prop archviz, single-mesh game
/// items) and degrades gracefully for the rest (the texture is wrong on some
/// objects but at least everything has something).</para>
/// </summary>
internal static class SiblingTextureHydrator
{
    // Filename-suffix heuristics. Tested against the wild — particularly
    // Renderpeople and Megascans naming, plus the Substance "TextureSet
    // _BaseColor / _Normal / _Roughness" convention.
    static readonly string[] DiffuseSuffixes  = { "_basecolor", "_base_color", "_albedo", "_diffuse", "_dif", "_diff", "_color", "_col", "_d" };
    static readonly string[] NormalSuffixes   = { "_normal", "_norm", "_nrm", "_n" };
    static readonly string[] RoughSuffixes    = { "_roughness", "_rough", "_rgh", "_r" };
    static readonly string[] MetalSuffixes    = { "_metallic", "_metalness", "_metal", "_met", "_m" };
    static readonly string[] EmissionSuffixes = { "_emissive", "_emission", "_emiss", "_e" };
    static readonly string[] AoSuffixes       = { "_ambientocclusion", "_occlusion", "_ao" };
    // Glossiness is the inverse of roughness — older pipelines use it. We only
    // accept it as a *fallback* when no roughness texture is present (we hand
    // it to Rhino as a roughness map; the visual will be inverted from the
    // author's intent, but it's better than fully-rough flat).
    static readonly string[] GlossSuffixes    = { "_glossiness", "_glossy", "_gloss", "_spec", "_specular", "_s" };

    static readonly string[] ImageExtensions  = { ".png", ".jpg", ".jpeg", ".bmp", ".tga", ".tif", ".tiff", ".exr", ".hdr", ".webp" };

    /// <summary>
    /// Synthesise a material from sibling textures when the importer brought
    /// in geometry but no materials. Returns the number of materials created
    /// (0 or 1 in the current implementation).
    /// </summary>
    /// <param name="doc">Freshly imported RhinoDoc.</param>
    /// <param name="sourcePath">Path of the file that was just imported.</param>
    /// <param name="diag">Optional diag sink; lines are forwarded to job_logs
    /// as <c>[FBX-HYDRATE]</c> entries.</param>
    public static int Hydrate(RhinoDoc doc, string sourcePath, Action<string>? diag = null)
    {
        try
        {
            if (doc.Materials.Count > 0)
            {
                diag?.Invoke($"[FBX-HYDRATE] skipping — importer already populated {doc.Materials.Count} material(s)");
                return 0;
            }
            if (doc.Objects.Count == 0)
            {
                diag?.Invoke("[FBX-HYDRATE] skipping — empty doc");
                return 0;
            }

            var dir = Path.GetDirectoryName(sourcePath);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir))
            {
                diag?.Invoke($"[FBX-HYDRATE] skipping — source directory missing ({dir ?? "<null>"})");
                return 0;
            }

            // Scan up to 2 dir levels deep (e.g. the common `tex/` subfolder).
            // Going deeper risks picking up unrelated thumbnails.
            var images = SafeEnumerateImages(dir, maxDepth: 2);
            if (images.Count == 0)
            {
                diag?.Invoke($"[FBX-HYDRATE] no image files found near {Path.GetFileName(sourcePath)}");
                return 0;
            }
            diag?.Invoke($"[FBX-HYDRATE] found {images.Count} sibling image file(s) — classifying by filename suffix");

            // Match by suffix. Prefer the largest file when multiple match
            // (e.g. `_dif.jpg` 5MB vs `_dif_thumb.jpg` 40KB).
            string? PickBySuffix(string[] suffixes) =>
                images
                    .Where(p =>
                    {
                        var stem = Path.GetFileNameWithoutExtension(p).ToLowerInvariant();
                        return suffixes.Any(s => stem.EndsWith(s, StringComparison.OrdinalIgnoreCase));
                    })
                    .OrderByDescending(p => SafeLength(p))
                    .FirstOrDefault();

            var diffuse   = PickBySuffix(DiffuseSuffixes);
            var normal    = PickBySuffix(NormalSuffixes);
            var roughness = PickBySuffix(RoughSuffixes);
            var metallic  = PickBySuffix(MetalSuffixes);
            var emission  = PickBySuffix(EmissionSuffixes);
            var gloss     = PickBySuffix(GlossSuffixes);

            // Heuristic backstop for "_a"/"_A" alpha-only or character-overview
            // images that don't fit any role suffix. If we found nothing role-
            // specific but the largest image looks like a colour map (jpg/png
            // with no normal-like green/blue colour cast inferred from the
            // filename), accept it as diffuse. We deliberately stay simple
            // here — better to bail than to attach the wrong texture.
            if (diffuse is null && normal is null && roughness is null && metallic is null && emission is null && gloss is null)
            {
                // Try: if EXACTLY one image lives next to the source file (not
                // in a subdir), use it as diffuse. Common for single-texture
                // game props.
                var siblings = images.Where(p => string.Equals(Path.GetDirectoryName(p), dir, StringComparison.OrdinalIgnoreCase)).ToList();
                if (siblings.Count == 1)
                {
                    diffuse = siblings[0];
                    diag?.Invoke($"[FBX-HYDRATE] no suffix matches; falling back to lone sibling image as diffuse: {Path.GetFileName(diffuse)}");
                }
                else
                {
                    diag?.Invoke($"[FBX-HYDRATE] {images.Count} image(s) but none match known PBR suffixes — leaving doc material-free");
                    return 0;
                }
            }

            diag?.Invoke(
                $"[FBX-HYDRATE] classified textures:" +
                $" diffuse={Format(diffuse)}" +
                $" normal={Format(normal)}" +
                $" roughness={Format(roughness)}" +
                $" metallic={Format(metallic)}" +
                $" emission={Format(emission)}" +
                $" gloss={Format(gloss)}");

            // If we have a gloss map but no roughness, hand the gloss to the
            // roughness slot. RhinoMaterialHelper / the viewer will treat it
            // as roughness so visuals will be inverted from the author's
            // intent — but most "_gloss" textures in the wild are close to
            // mid-grey and the difference is acceptable for prop assets. If
            // we ever add full Spec/Gloss → Metal/Rough conversion this is
            // the line to replace.
            if (roughness is null && gloss is not null)
            {
                diag?.Invoke($"[FBX-HYDRATE] no _roughness map; using {Path.GetFileName(gloss)} as roughness (visuals may be inverted)");
                roughness = gloss;
            }

            // Create the material and convert to PhysicallyBased. PBR is the
            // representation the connector's RhinoMaterialHelper strategy 2
            // already understands; bare Material.SetBitmapTexture would only
            // attach a diffuse texture via strategy 3.
            var matIdx = doc.Materials.Add();
            var mat = doc.Materials[matIdx];
            mat.Name = Path.GetFileNameWithoutExtension(sourcePath) + "_pbr";
            mat.ToPhysicallyBased();
            var pbr = mat.PhysicallyBased;
            if (pbr is null)
            {
                diag?.Invoke("[FBX-HYDRATE] ToPhysicallyBased() returned null — falling back to legacy bitmap-only material");
                if (diffuse is not null)
                {
                    mat.SetBitmapTexture(diffuse);
                }
                mat.CommitChanges();
            }
            else
            {
                void Attach(string role, string? path, TextureType slot)
                {
                    if (string.IsNullOrEmpty(path)) return;
                    try
                    {
                        var tex = new DocTexture
                        {
                            FileName = path,
                            Enabled = true,
                            TextureType = slot,
                        };
                        pbr.SetTexture(tex, slot);
                        diag?.Invoke($"[FBX-HYDRATE]   attach {role,-9} ({slot}) ← {Path.GetFileName(path)}");
                    }
                    catch (Exception ex)
                    {
                        diag?.Invoke($"[FBX-HYDRATE]   attach {role} failed: {ex.GetType().Name}: {ex.Message}");
                    }
                }

                Attach("basecolor", diffuse,   TextureType.PBR_BaseColor);
                Attach("normal",    normal,    TextureType.Bump);
                Attach("roughness", roughness, TextureType.PBR_Roughness);
                Attach("metallic",  metallic,  TextureType.PBR_Metallic);
                Attach("emission",  emission,  TextureType.PBR_Emission);

                mat.CommitChanges();
            }

            // Assign to every imported object so it shows up in every layer.
            int assigned = 0;
            foreach (var obj in doc.Objects)
            {
                try
                {
                    var attr = obj.Attributes.Duplicate();
                    attr.MaterialIndex = matIdx;
                    attr.MaterialSource = ObjectMaterialSource.MaterialFromObject;
                    if (doc.Objects.ModifyAttributes(obj, attr, quiet: true))
                        assigned++;
                }
                catch (Exception ex)
                {
                    diag?.Invoke($"[FBX-HYDRATE]   assign to {obj.Id} failed: {ex.GetType().Name}: {ex.Message}");
                }
            }

            diag?.Invoke($"[FBX-HYDRATE] created material '{mat.Name}' (PBR) and assigned to {assigned}/{doc.Objects.Count} object(s)");
            return 1;
        }
        catch (Exception err)
        {
            // Never let a hydration failure abort the import — at worst the
            // user gets a material-less model, which is what they would have
            // had without this helper.
            diag?.Invoke($"[FBX-HYDRATE] aborted ({err.GetType().Name}: {err.Message})");
            return 0;
        }
    }

    static List<string> SafeEnumerateImages(string root, int maxDepth)
    {
        var hits = new List<string>();
        void Walk(string dir, int depth)
        {
            if (depth > maxDepth) return;
            string[] files;
            try { files = Directory.GetFiles(dir); }
            catch { return; }
            foreach (var f in files)
            {
                if (ImageExtensions.Contains(Path.GetExtension(f).ToLowerInvariant()))
                    hits.Add(f);
            }
            string[] subs;
            try { subs = Directory.GetDirectories(dir); }
            catch { return; }
            foreach (var s in subs)
                Walk(s, depth + 1);
        }
        Walk(root, 0);
        return hits;
    }

    static long SafeLength(string path)
    {
        try { return new FileInfo(path).Length; } catch { return 0L; }
    }

    static string Format(string? p) => p is null ? "<none>" : Path.GetFileName(p);
}
