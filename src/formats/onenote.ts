import { OnenotePage, SectionGroup, User, FileAttachment, PublicError, Notebook, OnenoteSection } from '@microsoft/microsoft-graph-types';
import { DataWriteOptions, Notice, Setting, TFile, TFolder, htmlToMarkdown, ObsidianProtocolData, requestUrl, moment } from 'obsidian';
import { genUid, parseHTML } from '../util';
import { FormatImporter } from '../format-importer';
import { ATTACHMENT_EXTS, AUTH_REDIRECT_URI, ImportContext } from '../main';
import { AccessTokenResponse } from './onenote/models';

// const GRAPH_CLIENT_ID: string = '66553851-08fa-44f2-8bb1-1436f121a73d'; // default
const GRAPH_CLIENT_ID: string = '1431ce75-e37a-4960-a07e-829f47d1b62f';
const GRAPH_TENANT_ID: string = 'common';
// const GRAPH_TENANT_ID: string = '28b15cb4-8f40-4a9e-a22b-955e936b44c3';
const GRAPH_SCOPES: string[] = ['user.read', 'notes.read', 'offline_access'];
// Regex for fixing broken HTML returned by the OneNote API
const SELF_CLOSING_REGEX = /<(object|iframe)([^>]*)\/>/g;
// Regex for fixing whitespace and paragraphs
const PARAGRAPH_REGEX = /(<\/p>)\s*(<p[^>]*>)|\n  \n/g;
// Maximum amount of request retries, before they're marked as failed

const MAX_RETRY_ATTEMPTS = 60;
const DOWNLOAD_INTERVAL = 10;

// const RATE_LIMIT_WAIT = 40;
const RATE_LIMIT_RETRY = 60;

// // for sleep function
// function sleep(ms: number | undefined) {
// 	console.log(`Sleeping for ${ms} ms`);
// 	return new Promise(resolve => setTimeout(resolve, ms));
// }

class Lock {
	_locked: boolean;
	_waiting: Array<() => void>;

	constructor() {
		this._locked = false;
		this._waiting = [];
	}

	async acquire() {
		if (this._locked) {
			// @ts-ignore
			await new Promise(resolve => this._waiting.push(resolve));
		}
		this._locked = true;
	}

	release() {
		if (this._waiting.length > 0) {
			const next = this._waiting.shift();
			if (next) {
			  next();
			}
		} 
		else {
			this._locked = false;
		}
	}
}


class AsyncLock {
	_locked: boolean;
	_waiting: Array<(unlock: () => void) => void>;

	constructor() {
		this._locked = false;
		this._waiting = [];
	}

	async lock() {
		const unlock = () => {
			this._locked = false;
			if (this._waiting.length > 0) {
				const nextUnlock = this._waiting.shift();
				if (nextUnlock) {
					nextUnlock(unlock);
				}
			}
		};

		if (this._locked) {
			await new Promise((resolve) => this._waiting.push(resolve));
		} 
		else {
			this._locked = true;
			return unlock;
		}
	}
}

export class OneNoteImporter extends FormatImporter {
	// Settings
	outputFolder: TFolder | null;
	useDefaultAttachmentFolder: boolean = false;
	importIncompatibleAttachments: boolean = false;
	download_interval: number = DOWNLOAD_INTERVAL;
	// UI
	microsoftAccountSetting: Setting;
	contentArea: HTMLDivElement;
	// Internal
	selectedIds: string[] = [];
	notebooks: Notebook[] = [];
	graphData = {
		state: genUid(32),
		accessToken: '',
		refreshToken: '',
		expire_in: new Date()
	};
	lock = new Lock();
	asyncLock = new AsyncLock();

	init() {
		this.addOutputLocationSetting('OneNote');
		
		// Settings
		new Setting(this.modal.contentEl)
			.setName('Use the default attachment folder')
			.setDesc('If disabled, attachments will be stored in the export folder in the OneNote Attachments folder.')
			.addToggle((toggle) => toggle
				.setValue(this.useDefaultAttachmentFolder)
				.onChange((value) => (this.useDefaultAttachmentFolder = value))
			);
		new Setting(this.modal.contentEl)
			.setName('Import incompatible attachments')
			.setDesc('Imports incompatible attachments which cannot be embedded in Obsidian, such as .exe files.')
			.addToggle((toggle) => toggle
				.setValue(this.importIncompatibleAttachments)
				.onChange((value) => (this.importIncompatibleAttachments = value))
			);
		new Setting(this.modal.contentEl)
			.setName('Download interval')
			.setDesc('Time in seconds to wait between each download. This is useful to prevent rate limiting.')
			.addText((text) => text
				.setValue(DOWNLOAD_INTERVAL.toString())
				.onChange((value) => (this.download_interval = parseInt(value)))
			);
		this.microsoftAccountSetting =
			new Setting(this.modal.contentEl)
				.setName('Sign in with your Microsoft account')
				.setDesc('You need to sign in to import your OneNote data.')
				.addButton((button) => button
					.setCta()
					.setButtonText('Sign in')
					.onClick(() => {
						this.registerAuthCallback(this.authenticateUser.bind(this));
						const requestBody = new URLSearchParams({
							client_id: GRAPH_CLIENT_ID,
							scope: GRAPH_SCOPES.join(' '),
							response_type: 'code',
							redirect_uri: AUTH_REDIRECT_URI,
							response_mode: 'query',
							state: this.graphData.state,
						});
						window.open(`https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/authorize?${requestBody.toString()}`);
					})
				);
		this.contentArea = this.modal.contentEl.createEl('div');
	}

	async authenticateUser(protocolData: ObsidianProtocolData) {
		try {
			if (protocolData['state'] !== this.graphData.state) {
				throw new Error(`An incorrect state was returned.\nExpected state: ${this.graphData.state}\nReturned state: ${protocolData['state']}`);
			}
			await this.initToken(protocolData);

			// Emptying, as the user may have leftover selections from previous sign-in attempt
			this.selectedIds = [];
			const userData: User = await this.fetchResource('https://graph.microsoft.com/v1.0/me', 'json');
			this.microsoftAccountSetting.setDesc(
				`Signed in as ${userData.displayName} (${userData.mail}). If that's not the correct account, sign in again.`
			);

			await this.showSectionPickerUI();
		}
		catch (e) {
			console.error('An error occurred while we were trying to sign you in. Error details: ', e);
			this.modal.contentEl.createEl('div', { text: 'An error occurred while trying to sign you in.' })
				.createEl('details', { text: e })
				.createEl('summary', { text: 'Click here to show error details' });
		}
	}

	async initToken(protocolData: ObsidianProtocolData) {
		console.log('Getting token...');

		const requestBody = new URLSearchParams({
			client_id: GRAPH_CLIENT_ID,
			scope: GRAPH_SCOPES.join(' '),
			code: protocolData['code'],
			redirect_uri: AUTH_REDIRECT_URI,
			grant_type: 'authorization_code',
			// client_secret: GRAPH_CLIENT_SECRET
		});

		const tokenResponse: AccessTokenResponse = await requestUrl({
			method: 'POST',
			url: `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
			contentType: 'application/x-www-form-urlencoded',
			body: requestBody.toString(),
		}).json;

		if (!tokenResponse.access_token) {
			throw new Error(`Unexpected data was returned instead of an access token. Error details: ${tokenResponse}`);
		}

		console.log('Token response:', tokenResponse);
		console.log('Token expires in:', tokenResponse.expires_in);

		this.graphData.accessToken = tokenResponse.access_token;
		this.graphData.refreshToken = tokenResponse.refresh_token!;
		let now = new Date();
		this.graphData.expire_in = new Date(now.getTime() + (tokenResponse.expires_in - 600) * 1000);

		console.log('Set Expire in:', this.graphData.expire_in);
	}

	// refresh token
	async refreshToken() {
		try {
			console.log('Refreshing token...');
			const requestBody = new URLSearchParams({
				client_id: GRAPH_CLIENT_ID,
				scope: GRAPH_SCOPES.join(' '),
				grant_type: 'refresh_token',
				refresh_token: this.graphData.refreshToken,
				// client_secret: GRAPH_CLIENT_SECRET,
			});

			const tokenResponse: AccessTokenResponse = await requestUrl({
				method: 'POST',
				url: `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
				contentType: 'application/x-www-form-urlencoded',
				body: requestBody.toString(),
			}).json;

			if (!tokenResponse.access_token) {
				throw new Error(`Unexpected data was returned instead of an access token. Error details: ${tokenResponse}`);
			}

			console.log('Token response:', tokenResponse);
			console.log('Token expires in:', tokenResponse.expires_in);

			this.graphData.accessToken = tokenResponse.access_token;
			this.graphData.refreshToken = tokenResponse.refresh_token!;
			let now = new Date();
			this.graphData.expire_in = new Date(now.getTime() + (tokenResponse.expires_in - 600) * 1000);

			console.log('Set Expire in:', this.graphData.expire_in);
		}
		catch (e) {
			console.error('An error occurred while trying to refresh the token. Error details: ', e);
			throw e;
		}
	}

	async showSectionPickerUI() {
		const baseUrl = 'https://graph.microsoft.com/v1.0/me/onenote/notebooks';

		// Fetch the sections & section groups directly under the notebook
		const params = new URLSearchParams({
			$expand: 'sections($select=id,displayName),sectionGroups($expand=sections,sectionGroups)',
			$select: 'id,displayName,lastModifiedDateTime',
			$orderby: 'lastModifiedDateTime DESC',
		});
		const sectionsUrl = `${baseUrl}?${params.toString()}`;
		this.notebooks = (await this.fetchResource(sectionsUrl, 'json')).value;

		// Make sure the element is empty, in case the user signs in twice
		this.contentArea.empty();
		this.contentArea.createEl('h4', {
			text: 'Choose data to import',
		});

		for (const notebook of this.notebooks) {
			// Check if there are any nested section groups, if so, fetch them
			if (notebook.sectionGroups?.length !== 0) {
				for (const sectionGroup of notebook.sectionGroups!) {
					await this.fetchNestedSectionGroups(sectionGroup);
				}
			}

			let notebookDiv = this.contentArea.createDiv();

			new Setting(notebookDiv)
				.setName(notebook.displayName!)
				.setDesc(`Last edited on: ${(moment.utc(notebook.lastModifiedDateTime)).format('Do MMMM YYYY')}. Contains ${notebook.sections?.length} sections.`)
				.addButton((button) => button
					.setCta()
					.setButtonText('Select all')
					.onClick(() => {
						notebookDiv.querySelectorAll('input[type="checkbox"]:not(:checked)').forEach((el: HTMLInputElement) => el.click());
					}));
			this.renderHierarchy(notebook, notebookDiv);
		}
	}

	// Gets the content of a nested section group
	async fetchNestedSectionGroups(parentGroup: SectionGroup) {
		parentGroup.sectionGroups = (await this.fetchResource(parentGroup.sectionGroupsUrl + '?$expand=sectionGroups($expand=sections),sections', 'json')).value;

		if (parentGroup.sectionGroups) {
			for (let i = 0; i < parentGroup.sectionGroups.length; i++) {
				await this.fetchNestedSectionGroups(parentGroup.sectionGroups[i]);
			}
		}
	}

	// Renders a HTML list of all section groups and sections
	renderHierarchy(entity: SectionGroup | Notebook, parentEl: HTMLElement) {
		if (entity.sectionGroups) {
			for (const sectionGroup of entity.sectionGroups) {
				let sectionGroupDiv = parentEl.createDiv(
					{
						attr: {
							style: 'padding-inline-start: 1em; padding-top: 8px'
						}
					});

				sectionGroupDiv.createEl('strong', {
					text: sectionGroup.displayName!,
				});

				this.renderHierarchy(sectionGroup, sectionGroupDiv);
			}
		}

		if (entity.sections) {
			const sectionList = parentEl.createEl('ul', {
				attr: {
					style: 'padding-inline-start: 1em;',
				},
			});
			for (const section of entity.sections) {
				const listElement = sectionList.createEl('li', {
					cls: 'task-list-item',
				});
				let label = listElement.createEl('label');
				let checkbox = label.createEl('input');
				checkbox.type = 'checkbox';

				label.appendChild(document.createTextNode(section.displayName!));
				label.createEl('br');

				checkbox.addEventListener('change', () => {
					if (checkbox.checked) this.selectedIds.push(section.id!);
					else {
						const index = this.selectedIds.findIndex((sec) => sec === section.id);
						if (index !== -1) {
							this.selectedIds.splice(index, 1);
						}
					}
				});
			}
		}
	}

	async import(progress: ImportContext): Promise<void> {
		this.outputFolder = (await this.getOutputFolder());

		if (!this.outputFolder) {
			new Notice('Please select a location to export to.');
			return;
		}

		if (!this.graphData.accessToken) {
			new Notice('Please sign in to your Microsoft Account.');
			return;
		}

		progress.status('Starting OneNote import');

		let progressTotal = 0;
		let progressCurrent = 0;

		for (let sectionId of this.selectedIds) {
			progress.reportProgress(progressCurrent, progressTotal);

			const baseUrl = `https://graph.microsoft.com/v1.0/me/onenote/sections/${sectionId}/pages`;
			const params = new URLSearchParams({
				$select: 'id,title,createdDateTime,lastModifiedDateTime,level,order,contentUrl',
				$orderby: 'order',
				pagelevel: 'true'
			});

			const pagesUrl = `${baseUrl}?${params.toString()}`;

			console.log('Fetching pages from:', pagesUrl);
			let pages: OnenotePage[] = ((await this.fetchResource(pagesUrl, 'json')).value);
			progressTotal += pages.length;
			this.insertPagesToSection(pages, sectionId);

			progress.reportProgress(progressCurrent, progressTotal);

			for (let i = 0; i < pages.length; i++) {
				const page = pages[i];
				if (!page.title) page.title = `Untitled-${moment().format('YYYYMMDDHHmmss')}`;
				try {
					progress.status(`Importing note ${page.title}`);
					// // Every 10 items, do a few second break to prevent rate limiting
					// if (i !== 0 && i % 10 === 0) {
					// 	await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WAIT * 1000));
					// }

					this.processFile(progress,
						await this.fetchResource(`https://graph.microsoft.com/v1.0/me/onenote/pages/${page.id}/content?includeInkML=true`, 'text'),
						page);

					progressCurrent++;
					progress.reportProgress(progressCurrent, progressTotal);
				}
				catch (e) {
					console.error('An error occurred while trying to import a note. Error details: ', e);
					progress.reportFailed(page.title, e.toString());
				}
			}
		}
	}

	insertPagesToSection(pages: OnenotePage[], sectionId: string, parentEntity?: Notebook | SectionGroup) {
		if (!parentEntity) {
			for (const notebook of this.notebooks) {
				this.insertPagesToSection(pages, sectionId, notebook);
			}
			return;
		}

		if (parentEntity.sectionGroups) {
			// Recursively search in section groups
			const sectionGroups: SectionGroup[] = parentEntity.sectionGroups;
			for (const sectionGroup of sectionGroups) {
				this.insertPagesToSection(pages, sectionId, sectionGroup);
			}
		}

		if (parentEntity.sections) {
			// Recursively search in sections
			const sectionGroup = parentEntity;
			for (const section of sectionGroup.sections!) {
				if (section.id === sectionId) {
					section.pages = pages;
				}
			}
		}
	}

	async processFile(progress: ImportContext, content: string, page: OnenotePage) {
		try {
			const splitContent = this.convertFormat(content);
			const outputPath = this.getEntityPathNoParent(page.id!, this.outputFolder!.name)!;

			let pageFolder: TFolder;
			if (!await this.vault.adapter.exists(outputPath)) pageFolder = await this.vault.createFolder(outputPath);
			else pageFolder = this.vault.getAbstractFileByPath(outputPath) as TFolder;

			let taggedPage = this.convertTags(parseHTML(splitContent.html));
			let data = this.getAllAttachments(taggedPage.replace(PARAGRAPH_REGEX, '<br />'));
			let parsedPage = this.styledElementToHTML(data.html);
			parsedPage = this.convertInternalLinks(parsedPage);
			parsedPage = this.convertDrawings(parsedPage);

			let mdContent = htmlToMarkdown(parsedPage).trim().replace(PARAGRAPH_REGEX, ' ');
			const fileRef = await this.saveAsMarkdownFile(pageFolder, page.title!, mdContent);

			await this.fetchAttachmentQueue(progress, fileRef, this.outputFolder!, data.queue);

			// Add the last modified and creation time metadata
			const writeOptions: DataWriteOptions = {
				ctime: page?.lastModifiedDateTime ? Date.parse(page.lastModifiedDateTime.toString()) :
					page?.createdDateTime ? Date.parse(page.createdDateTime.toString()) :
						Date.now(),
				mtime: page?.lastModifiedDateTime ? Date.parse(page.lastModifiedDateTime.toString()) :
					page?.createdDateTime ? Date.parse(page.createdDateTime.toString()) :
						Date.now(),
			};
			await this.vault.append(fileRef, '', writeOptions);
			progress.reportNoteSuccess(page.title!);
		}
		catch (e) {
			console.error('An error occurred while trying to import a note. Error details: ', e);
			progress.reportFailed(page.title!, e);
		}
	}

	// OneNote returns page data and inking data in one file, so we need to split them
	convertFormat(input: string): { html: string, inkml: string } {
		const output = { html: '', inkml: '' };

		// HTML and InkML files are split by a boundary, which is defined in the first line of the input
		const boundary = input.split('\n', 1)[0];

		input.slice(0, -2); // Remove the last 2 characters of the input (as they break the InkML boundary)
		const parts: string[] = input.split(boundary); // Split the file into 2 parts
		parts.shift(); // Remove the first array item as it's just an empty string

		if (parts.length === 2) {
			for (let part of parts) {
				let contentTypeLine = part.split('\n').find((line) => line.includes('Content-Type'));
				let contentType = contentTypeLine!
					.split(';')[0]
					.split(':')[1]
					.trim();

				// Extract the value from the part by removing the first two lines
				let value = part.split('\n').slice(2).join('\n').trim();

				if (contentType === 'text/html') output.html = value;
				else if (contentType === 'application/inkml+xml') output.inkml = value;
			}
		}
		else {
			throw new Error('The input string is incorrect and may be missing data. Inputted string: ' + input);
		}

		return output;
	}

	convertTags(pageElement: HTMLElement): string {
		const tagElements = Array.from(pageElement.querySelectorAll('[data-tag]'));

		for (const element of tagElements) {
			// If a to-do tag, then convert it into a Markdown task list
			if (element.getAttribute('data-tag')?.contains('to-do')) {
				const isChecked = element.getAttribute('data-tag') === 'to-do:completed';
				const check = isChecked ? '[x]' : '[ ]';
				// We need to use innerHTML in case an image was marked as TO-DO
				element.innerHTML = `- ${check} ${element.innerHTML}`;
			}
			// All other OneNote tags are already in the Obsidian tag format ;)
			else {
				const tags = element.getAttribute('data-tag')?.split(',');
				tags?.forEach((tag) => {
					element.innerHTML = element.innerHTML + ` #${tag.replace(':', '-')} `;
				});
			}
		}
		return pageElement.outerHTML;
	}

	convertInternalLinks(pageElement: HTMLElement): HTMLElement {
		const links: HTMLAnchorElement[] = pageElement.findAll('a') as HTMLAnchorElement[];
		for (const link of links) {
			if (link.href.startsWith('onenote:')) {
				const startIdx = link.href.indexOf('#') + 1;
				const endIdx = link.href.indexOf('&', startIdx);
				link.href = link.href.slice(startIdx, endIdx);
			}
		}
		return pageElement;
	}

	getEntityPathNoParent(entityID: string, currentPath: string): string | null {
		for (const notebook of this.notebooks) {
			const path = this.getEntityPath(entityID, `${currentPath}/${notebook.displayName}`, notebook);
			if (path) return path;
		}
		return null;
	}

	/**
	 * Returns a filesystem path for any OneNote entity (e.g. sections or notes)
	 * Paths are returned in the following format:
	 * (Export folder)/Notebook/(possible section groups)/Section/(possible pages with a higher level)
	 */
	getEntityPath(entityID: string, currentPath: string, parentEntity: Notebook | SectionGroup | OnenoteSection): string | null {
		let returnPath: string | null = null;

		if ('sectionGroups' in parentEntity && parentEntity.sectionGroups) {
			const path = this.searchSectionGroups(entityID, currentPath, parentEntity.sectionGroups);
			if (path !== null) returnPath = path;
		}

		if ('sections' in parentEntity && parentEntity.sections) {
			const path = this.searchSectionGroups(entityID, currentPath, parentEntity.sections);
			if (path !== null) returnPath = path;
		}

		if ('pages' in parentEntity && parentEntity.pages) {
			const path = this.searchPages(entityID, currentPath, parentEntity);
			if (path !== null) returnPath = path;
		}

		return returnPath;
	}

	private searchPages(entityID: string, currentPath: string, section: OnenoteSection): string | null {
		let returnPath: string | null = null;
		// Check if the target page is in the current entity's pages
		for (let i = 0; i < section.pages!.length; i++) {
			const page = section.pages![i];
			const pageContentID = page.contentUrl!.split('page-id=')[1]?.split('}')[0];

			if (page.id === entityID || pageContentID === entityID) {
				if (page.level === 0) {
					/* Checks if we have a page leveled below this one.
					 * without this line, leveled notes are more scattered:
					 * ...Section/Example.md, *but* ...Section/Example/Lower level.md
					 * with this line both files are in one neat directory:
					 * ...Section/Example/Page.md and ...Section/Example/Lower level.md
					 */
					if (section.pages![i + 1] && section.pages![i + 1].level !== 0) {
						returnPath = `${currentPath}/${page.title}`;
					}
					else returnPath = currentPath;
				}
				else {
					returnPath = currentPath;

					// Iterate backward to find the parent page
					for (let i = section.pages!.indexOf(page) - 1; i >= 0; i--) {
						if (section.pages![i].level === page.level! - 1) {
							returnPath += '/' + section.pages![i].title;
							break;
						}
					}
				}
				break;
			}
		}
		return returnPath;
	}

	private searchSectionGroups(entityID: string, currentPath: string, sectionGroups: SectionGroup[] | OnenoteSection[]): string | null {
		// Recursively search in section groups
		let returnPath: string | null = null;
		for (const sectionGroup of sectionGroups) {
			if (sectionGroup.id === entityID) returnPath = `${currentPath}/${sectionGroup.displayName}`;
			else {
				const foundPath = this.getEntityPath(entityID, `${currentPath}/${sectionGroup.displayName}`, sectionGroup);
				if (foundPath) {
					returnPath = foundPath;
					break;
				}
			}
		}
		return returnPath;
	}

	// This function gets all attachments and adds them to the queue, as well as adds embedding syntax for supported file formats
	getAllAttachments(pageHTML: string): { html: HTMLElement, queue: FileAttachment[] } {
		const pageElement = parseHTML(pageHTML.replace(SELF_CLOSING_REGEX, '<$1$2></$1>'));

		const objects: HTMLElement[] = pageElement.findAll('object');
		const images: HTMLImageElement[] = pageElement.findAll('img') as HTMLImageElement[];
		// Online videos are implemented as iframes, normal videos are just <object>s
		const videos: HTMLIFrameElement[] = pageElement.findAll('iframe') as HTMLIFrameElement[];

		const attachmentQueue: FileAttachment[] = [];

		for (const object of objects) {
			let split: string[] = object.getAttribute('data-attachment')!.split('.');
			const extension: string = split[split.length - 1];

			// If the page contains an incompatible file and user doesn't want to import them, skip
			if (!ATTACHMENT_EXTS.contains(extension) && !this.importIncompatibleAttachments) {
				continue;
			}
			else {
				attachmentQueue.push({
					name: object.getAttribute('data-attachment')!,
					contentLocation: object.getAttribute('data')!,
				});

				// Create a new <p> element with the Markdown-style link
				const markdownLink = document.createElement('p');
				markdownLink.innerText = `![[${object.getAttribute('data-attachment')}]]`;

				// Replace the <object> tag with the new <p> element
				object.parentNode?.replaceChild(markdownLink, object);
			}
		}

		for (let i = 0; i < images.length; i++) {
			const image = images[i];
			let split: string[] = image.getAttribute('data-fullres-src-type')!.split('/');
			const extension: string = split[1];
			const currentDate = moment().format('YYYYMMDDHHmmss');
			const fileName: string = `Exported image ${currentDate}-${i}.${extension}`;

			attachmentQueue.push({
				name: fileName,
				contentLocation: image.getAttribute('data-fullres-src')!,
			});

			image.src = encodeURIComponent(fileName);
			if (!image.alt) image.alt = 'Exported image';
			else image.alt = image.alt.replace(/[\r\n]+/gm, '');
		}

		for (const video of videos) {
			// Obsidian only supports embedding YouTube videos, unlike OneNote
			if (video.src.contains('youtube.com') || video.src.contains('youtu.be')) {
				const embedNode = document.createTextNode(`![Embedded YouTube video](${video.src})`);
				video.parentNode?.replaceChild(embedNode, video);
			}
			else {
				// If it's any other website, convert to a basic link
				const linkNode = document.createElement('a');
				linkNode.href = video.src;
				video.parentNode?.replaceChild(linkNode, video);
			}
		}

		return { html: pageElement, queue: attachmentQueue };
	}

	// Downloads attachments from the attachmentQueue once the file has been created.
	async fetchAttachmentQueue(progress: ImportContext, currentFile: TFile, outputFolder: TFolder, attachmentQueue: FileAttachment[]) {
		if (attachmentQueue.length >= 1) {
			let attachmentPath: string = outputFolder.path + '/OneNote Attachments';
			// @ts-ignore
			// Bug: This function always returns the path + "Note name.md" rather than just the path for some reason
			if (this.useDefaultAttachmentFolder) attachmentPath = attachmentPath + '/' + (await this.app.vault.getAvailablePathForAttachments(currentFile.basename, currentFile.extension, currentFile));

			// Create the attachment folder if it doesn't exist yet
			try {
				console.log('Creating attachment folder:', attachmentPath);
				this.vault.createFolder(attachmentPath);
				// if (!this.vault.adapter.exists(attachmentPath)) {
				// 	console.log('Attachment folder does not exist, creating it now.');
				// 	this.vault.createFolder(attachmentPath);
				// }
			}
			catch (e) { }
			for (let i = 0; i < attachmentQueue.length; i++) {
				const attachment = attachmentQueue[i];
				try {
					// Every 3 attachments, do a few second break to prevent rate limiting
					// if (i !== 0 && i % 3 === 0) {
					// 	await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_WAIT * 1000));
					// }

					if (!(await this.vault.adapter.exists(`${attachmentPath}/${attachment.name}`))) {
						const data = (await this.fetchResource(attachment.contentLocation!, 'file')) as ArrayBuffer;
						await this.app.vault.createBinary(attachmentPath + '/' + attachment.name, data);
					}
					else progress.reportSkipped(attachment.name!);
				}
				catch (e) {
					console.error('An error occurred while trying to download an attachment. Error details: ', e);
					progress.reportFailed(attachment.name!, e);
				}
			}
		}
	}

	// Convert OneNote styled elements to valid HTML for proper htmlToMarkdown conversion
	styledElementToHTML(pageElement: HTMLElement): HTMLElement {
		// Map styles to their elements
		const styleMap: { [key: string]: string } = {
			'font-weight:bold': 'b',
			'font-style:italic': 'i',
			'text-decoration:underline': 'u',
			'text-decoration:line-through': 's',
			'background-color': 'mark',
		};
		// Cites/quotes are not converted into Markdown (possible htmlToMarkdown bug?), so we do it ourselves temporarily
		const cites = pageElement.findAll('cite');
		cites.forEach((cite) => cite.innerHTML = '> ' + cite.innerHTML + '<br>');

		// Convert preformatted text into code blocks
		let inCodeBlock: boolean = false;
		let codeElement: HTMLElement = document.createElement('pre');

		const elements = pageElement.querySelectorAll('*');
		elements.forEach(element => {
			const style = element.getAttribute('style') || '';
			const matchingStyle = Object.keys(styleMap).find(key => style.includes(key));

			if (style?.contains('font-family:Consolas')) {
				if (!inCodeBlock) {
					inCodeBlock = true;
					element.replaceWith(codeElement);
					codeElement.innerHTML = '```\n' + element.innerHTML + '\n```';
				}
				else {
					// Append the content and add fences in case there's no next element
					codeElement.innerHTML = codeElement.innerHTML.slice(0, -3) + element.innerHTML + '\n```';
				}
			}
			else if (element.nodeName === 'BR' && inCodeBlock) {
				codeElement.innerHTML = codeElement.innerHTML.slice(0, -3) + '\n```';
			}
			else {
				if (matchingStyle) {
					const newElementTag = styleMap[matchingStyle];
					const newElement = document.createElement(newElementTag);
					newElement.innerHTML = element.innerHTML;
					element.replaceWith(newElement);
				}
			}
		});
		return pageElement;
	}

	convertDrawings(element: HTMLElement): HTMLElement {
		// TODO: Convert using InkML, this is a temporary notice for users to know drawings were skipped
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_COMMENT);
		let hasDrawings: boolean = false;

		while (walker.nextNode()) {
			const commentNode = walker.currentNode as Comment;
			if (commentNode.nodeValue?.trim() === 'InkNode is not supported') hasDrawings = true;
		}

		if (hasDrawings) {
			const textNode = document.createTextNode('> [!caution] This page contained a drawing which was not converted.');
			// Insert the notice at the top of the page
			element.insertBefore(textNode, element.firstChild);
		}
		else {
			for (let i = 0; i < element.children.length; i++) {
				const child = element.children[i];
				if (child instanceof HTMLElement) {
					this.convertDrawings(child);
				}
			}
		}
		return element;
	}



	// Fetches an Microsoft Graph resource and automatically handles rate-limits/errors
	async fetchResource(url: string, returnType: 'text', retryCount?: number | undefined): Promise<string>;
	async fetchResource(url: string, returnType: 'file', retryCount?: number | undefined): Promise<ArrayBuffer>;
	async fetchResource(url: string, returnType: 'json', retryCount?: number | undefined): Promise<any>;
	async fetchResource(url: string, returnType: 'text' | 'file' | 'json' = 'json', retryCount: number = 0): Promise<string | ArrayBuffer | any> {
		if (retryCount === undefined) {
			retryCount = 0;
		} 

		try {
			if (this.download_interval > 0) {
				console.log(`Waiting for ${this.download_interval} seconds before fetching:`); 
				await new Promise(resolve => setTimeout(resolve, this.download_interval * 1000));
			} 
			let unlock = undefined;
			let response;
			let responseBody;
			try {
				console.log(`${retryCount}: Fetching resource: ${url}`);
				// await this.lock.acquire();
				unlock = await this.asyncLock.lock();
				// refresh token
				let now = new Date();
				// If the token is about to expire, refresh it with the refresh token
				if (now >= this.graphData.expire_in) {
					await this.refreshToken();
				}
				response = await fetch(url, { headers: { Authorization: `Bearer ${this.graphData.accessToken}` } });
			}
			finally {
				// this.lock.release();
				if (unlock) {
					unlock();
				}
			}

			if (response?.ok) {
				console.log('Completed fetch');
				switch (returnType) {
					case 'text':
						responseBody = await response.text();
						break;
					case 'file':
						responseBody = await response.arrayBuffer();
						break;
					default:
						responseBody = await response.json();
						if ('@odata.nextLink' in responseBody) {
							responseBody.value.push(...(await this.fetchResource(responseBody['@odata.nextLink'], 'json')).value);
						}
						break;
				}
			}
			else {
				// @ts-ignore
				const e: any = await response.json();
				if ('error' in e) {
					let err: PublicError = e.error;
					console.error('An error has occurred while fetching an resource:', err);
					// We're rate-limited - let's retry after the suggested amount of time
					if (err.code === '20166') {
						let retryTime = RATE_LIMIT_RETRY;
						if (response?.headers.get('Retry-After')) {
							console.log('Retry-After:', response.headers.get('Retry-After'));
							retryTime = parseInt(response.headers.get('Retry-After') || RATE_LIMIT_RETRY.toString()) + 10;
						}
						console.error(`Rate limit exceeded, waiting for: ${retryTime} sec`);
						if (retryCount < MAX_RETRY_ATTEMPTS) {
							await new Promise(resolve => setTimeout(resolve, retryTime * 1000));
							return (await this.fetchResource(url, returnType as any, retryCount + 1));
						}
						else throw new Error('Exceeded maximum retry attempts');
					}
				}
			}
			return responseBody;
		}
		catch (e) {
			console.error(`An internal error occurred while trying to fetch '${url}'. Error details: `, e);
			throw e;
		}
	}
}
