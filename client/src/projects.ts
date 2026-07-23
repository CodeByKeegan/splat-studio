// Projects: the project picker, switching (clears per-project viewer/undo
// state), and creating a new project.
import * as api from './api';
import { $, fileList, projectSelect } from './dom';
import { lodMetaCache } from './state';
import { showToast, promptText } from './ui';
import { clearViewport } from './viewport';
import { refreshFiles } from './files-panel';
import { loadGroup } from './groups';
import { clearUndoHistory } from './undo';

export const PROJECT_KEY = 'splat-studio.project';

const switchProject = async (name: string) => {
    api.setProject(name);
    projectSelect.value = name;
    localStorage.setItem(PROJECT_KEY, name);
    lodMetaCache.clear(); // keyed name@mtime within a project
    // loaded layers belong to the project we're leaving
    clearViewport();
    await refreshFiles();
    await loadGroup(); // tick the saved group members for this project
    clearUndoHistory(); // undo history doesn't span a project switch
};

// refresh the project picker; selects `preferred` (or the first project)
export const loadProjects = async (preferred?: string): Promise<void> => {
    const projects = await api.listProjects();
    projectSelect.innerHTML = '';
    for (const name of projects) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        projectSelect.appendChild(opt);
    }
    if (projects.length === 0) {
        api.setProject('');
        // clear anything from the workspace we just left (no project to refreshFiles)
        clearViewport();
        fileList.innerHTML = '';
        showToast('No projects yet — click "+ New" to create one', true);
        return;
    }
    await switchProject(projects.includes(preferred ?? '') ? preferred! : projects[0]);
};

projectSelect.onchange = () => void switchProject(projectSelect.value)
    .catch((err) => showToast(`Couldn't switch project: ${err}`, true));

$<HTMLButtonElement>('project-new').onclick = async () => {
    const name = await promptText('New project name', { okLabel: 'Create', placeholder: 'my-scene' });
    if (!name) return;
    try {
        await api.createProject(name);
        await loadProjects(name);
        showToast(`Created project "${name}"`);
    } catch (err) {
        showToast(`Couldn't create project: ${err}`, true);
    }
};
