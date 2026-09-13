import type {
	ProjectContext,
	ProjectFileResult,
	ProjectPathResult,
} from "../../../src/native/contracts";

interface ProjectServiceOptions {
	getCurrentProjectPath: () => string | null;
	getCurrentVideoPath: () => string | null;
	saveProjectFile: (
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) => Promise<ProjectFileResult>;
	loadProjectFile: (projectFolder?: string) => Promise<ProjectFileResult>;
	loadCurrentProjectFile: () => Promise<ProjectFileResult>;
	loadProjectFileFromPath: (path: string) => Promise<ProjectFileResult>;
	setCurrentVideoPath: (path: string) => ProjectPathResult | Promise<ProjectPathResult>;
	getCurrentVideoPathResult: () => ProjectPathResult;
	clearCurrentVideoPath: () => ProjectPathResult;
}

export class ProjectService {
	constructor(private readonly options: ProjectServiceOptions) {}

	getCurrentContext(): ProjectContext {
		return {
			currentProjectPath: this.options.getCurrentProjectPath(),
			currentVideoPath: this.options.getCurrentVideoPath(),
		};
	}

	async saveProjectFile(
		projectData: unknown,
		suggestedName?: string,
		existingProjectPath?: string,
	) {
		const result = await this.options.saveProjectFile(
			projectData,
			suggestedName,
			existingProjectPath,
		);
		return result;
	}

	async loadProjectFile(projectFolder?: string) {
		const result = await this.options.loadProjectFile(projectFolder);
		return result;
	}

	async loadCurrentProjectFile() {
		const result = await this.options.loadCurrentProjectFile();
		return result;
	}

	async loadProjectFileFromPath(path: string) {
		const result = await this.options.loadProjectFileFromPath(path);
		return result;
	}

	async setCurrentVideoPath(path: string) {
		const result = await this.options.setCurrentVideoPath(path);
		return result;
	}

	getCurrentVideoPath() {
		const result = this.options.getCurrentVideoPathResult();
		return result;
	}

	clearCurrentVideoPath() {
		const result = this.options.clearCurrentVideoPath();
		return result;
	}
}
