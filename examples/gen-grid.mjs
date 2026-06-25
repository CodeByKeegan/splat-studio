// Sample procedural splat generator for @playcanvas/splat-transform.
//
// A .mjs input lets the CLI synthesize gaussians programmatically. The module
// must export a `Generator` class with a static async `create(params)` method
// returning { count, columnNames, getRow(index, row) }. `params` is the array
// of { name, value } pairs parsed from -p/--params (values are strings).
//
// Use it in Splat Studio: drop this file in (or click "+ sample generator"),
// pick it as the Convert input, set params like width=16,height=16,scale=4,
// and convert to PLY/SOG. Or pass it straight to the CLI:
//   splat-transform gen-grid.mjs -p width=16,height=16,scale=4 grid.ply -w
//
// Column values are raw (the format the readers/writers store):
//   scale_* in log space, opacity as a logit, f_dc_* as SH DC coefficients.
const SH_C0 = 0.28209479177387814;
const toSH = c => (c - 0.5) / SH_C0;        // colour [0..1] -> f_dc
const toLogit = a => Math.log(a / (1 - a)); // alpha  [0..1] -> opacity

class Generator {
    // Optional: advertise params so the GUI renders live sliders for them.
    static params = [
        { name: 'width', label: 'Width', min: 1, max: 64, step: 1, default: 16 },
        { name: 'height', label: 'Height', min: 1, max: 64, step: 1, default: 16 },
        { name: 'scale', label: 'Scale (m)', min: 0.5, max: 20, step: 0.5, default: 4 }
    ];

    static async create(params) {
        const map = new Map(params.map(p => [p.name, p.value]));
        const num = (key, def) => {
            const v = map.get(key);
            const n = v === undefined ? def : Number(v);
            return Number.isFinite(n) ? n : def;
        };
        const width = Math.max(1, Math.floor(num('width', 8)));
        const height = Math.max(1, Math.floor(num('height', 8)));
        const scale = num('scale', 1);
        const logScale = Math.log(0.02 * scale); // gaussian radius, log space
        const opacity = toLogit(0.99);
        const spacing = 0.1 * scale;
        return {
            count: width * height,
            columnNames: ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2',
                'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'],
            getRow(index, row) {
                const col = index % width;
                const rowIdx = Math.floor(index / width);
                row.x = (col - (width - 1) / 2) * spacing;
                row.y = 0;
                row.z = (rowIdx - (height - 1) / 2) * spacing;
                row.scale_0 = row.scale_1 = row.scale_2 = logScale;
                row.rot_0 = 1; row.rot_1 = 0; row.rot_2 = 0; row.rot_3 = 0; // identity quat
                row.f_dc_0 = toSH(col / Math.max(1, width - 1));
                row.f_dc_1 = toSH(rowIdx / Math.max(1, height - 1));
                row.f_dc_2 = toSH(0.5);
                row.opacity = opacity;
            }
        };
    }
}

export { Generator };
