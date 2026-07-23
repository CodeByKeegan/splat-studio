// Linked group: fan the Edit transforms / region ops out to every ticked member
// (the LODs of one location stay consistent). Edit on a proxy, apply to all.
import * as api from './api';
import { $, convertInput, convertFormat } from './dom';
import { splatFileNames } from './state';
import { showToast } from './ui';
import { panelValid, runJob } from './jobs';
import { filesRefreshHooks, selectedFiles } from './files-panel';
import { baseLabel } from './lod-panel';
import { editTransformOptions, carveRegion, regionMode } from './edit-panel';

// Edit on a proxy (the loaded splat / Convert input), then fan the same transform +
// filter ops out to every ticked member — the LODs of one location stay consistent.
const groupMembersEl = $<HTMLDivElement>('group-members');
const groupApplyBtn = $<HTMLButtonElement>('group-apply');
const groupApplyRegionBtn = $<HTMLButtonElement>('group-apply-region');
const groupWarn = $<HTMLDivElement>('group-warn');

const checkedMembers = (): string[] =>
    [...groupMembersEl.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);

const updateGroupApply = (): void => {
    const n = checkedMembers().length;
    const suffix = n ? `to ${n} member${n > 1 ? 's' : ''}` : 'to members';
    groupApplyBtn.textContent = `Apply transforms ${suffix}`;
    groupApplyBtn.disabled = n === 0;
    groupApplyRegionBtn.textContent = `Apply region ${suffix}`;
    groupApplyRegionBtn.disabled = n === 0 || !carveRegion(); // needs a box/sphere set in Edit
};

const persistGroup = (): void => {
    void api.saveGroup({ members: checkedMembers(), proxy: convertInput.value || null }).catch(() => { /* best-effort */ });
};

// (re)build the member checkboxes from the project splats, preserving the ticked set
const renderGroupMembers = (preselect: Set<string>): void => {
    groupMembersEl.innerHTML = '';
    for (const name of splatFileNames) {
        const row = document.createElement('label');
        row.className = 'group-member';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.checked = preselect.has(name);
        cb.onchange = () => { updateGroupApply(); persistGroup(); };
        const span = document.createElement('span');
        span.textContent = name;
        row.append(cb, span);
        groupMembersEl.appendChild(row);
    }
    updateGroupApply();
};
filesRefreshHooks.push(() => renderGroupMembers(new Set(checkedMembers()))); // keep ticks across refreshes
// the region-apply button's enabled state tracks the Edit carve toggles
for (const id of ['carve-box-on', 'carve-sphere-on']) $(id).addEventListener('change', () => updateGroupApply());

// load the saved group for the active project and tick its members
export const loadGroup = async (): Promise<void> => {
    let saved: api.LocationGroup = { members: [], proxy: null };
    try { saved = await api.getGroup(); } catch { /* none yet */ }
    renderGroupMembers(new Set(saved.members.filter((m) => splatFileNames.includes(m))));
};

// Files-panel bulk bar: add the selected splats to the linked group
$<HTMLButtonElement>('bulk-group').onclick = () => {
    const adds = [...selectedFiles].filter((n) => splatFileNames.includes(n));
    if (!adds.length) return showToast('No splat files selected — only splat files can join a linked group', true);
    renderGroupMembers(new Set([...checkedMembers(), ...adds]));
    persistGroup();
    showToast(`Added ${adds.length} file${adds.length > 1 ? 's' : ''} to the linked group`);
};

groupApplyBtn.onclick = async () => {
    const members = checkedMembers();
    if (!members.length) return showToast('Tick at least one member', true);
    if (!panelValid('panel-convert')) return;
    const format = convertFormat.value;
    if (format === 'csv') {
        return showToast('Pick a splat output format in the Export panel (PLY / SOG / …) — CSV doesn’t carry these per-gaussian edits', true);
    }
    groupWarn.classList.add('hidden');
    groupApplyBtn.disabled = true;
    groupApplyRegionBtn.disabled = true; // claim both buttons — the stats await below is a re-entrancy gap
    try {
        // frame-compat guard: members of one location should have similar extents
        const stats = (await Promise.all(members.map((m) => api.getStats(m).catch(() => null)))).filter(Boolean);
        const sizes = stats.map((s) => Math.max(...s!.extents.filter(Number.isFinite))).filter(Number.isFinite);
        if (sizes.length > 1) {
            const ratio = Math.max(...sizes) / Math.max(Math.min(...sizes), 1e-6);
            if (ratio > 3) {
                groupWarn.textContent = `These members span very different sizes (≈${ratio.toFixed(1)}× extent) — they may not be the same location.`;
                groupWarn.className = 'hint warn';
                if (!confirm('These members have quite different extents and may not be the same location. Apply the transforms to all of them anyway?')) return;
            }
        }
        // fan the Edit transform out to each member, one at a time — a member's
        // failure stops the loop before the rest submit
        const options = {
            ...editTransformOptions(),
            device: $<HTMLSelectElement>('convert-device').value
        };
        const outputs: string[] = [];
        for (const member of members) {
            const job = await runJob(() => api.startConvert({ input: member, format, options }), undefined, false);
            if (!job || job.status !== 'done') { showToast(`Stopped — ${baseLabel(member)} did not finish`, true); break; }
            outputs.push(...job.outputs);
        }
        if (outputs.length) showToast(`Applied to ${outputs.length} member${outputs.length > 1 ? 's' : ''}: ${outputs.join(', ')}`);
    } finally {
        updateGroupApply(); // restore the enabled state + count label
    }
};

// fan the Edit-panel Region (carve / crop) out to every ticked member — a removal or
// crop on the proxy propagates to all its LODs. Any-format members work (non-PLY ones
// are decompressed to PLY by the trim worker); each writes a trimmed .ply.
groupApplyRegionBtn.onclick = async () => {
    const members = checkedMembers();
    if (!members.length) return showToast('Tick at least one member', true);
    const region = carveRegion();
    if (!region) return showToast('Enable a Box or Sphere region in the Edit panel first', true);
    const mode = regionMode();
    const verb = mode === 'keep' ? 'Crop (keep only inside the region)' : 'Carve (remove inside the region)';
    if (!confirm(`${verb} on ${members.length} member${members.length > 1 ? 's' : ''}? Each writes a new trimmed .ply — the sources are left untouched.`)) return;
    groupWarn.classList.add('hidden');
    groupApplyBtn.disabled = true;
    groupApplyRegionBtn.disabled = true; // claim both buttons for the run
    try {
        const outputs: string[] = [];
        for (const member of members) {
            const job = await runJob(() => api.startTrim({ input: member, options: { mode, ...region } }), undefined, false);
            if (!job || job.status !== 'done') { showToast(`Stopped — ${baseLabel(member)} did not finish`, true); break; }
            outputs.push(...job.outputs);
        }
        if (outputs.length) showToast(`Region applied to ${outputs.length} member${outputs.length > 1 ? 's' : ''}: ${outputs.join(', ')}`);
    } finally {
        updateGroupApply();
    }
};
