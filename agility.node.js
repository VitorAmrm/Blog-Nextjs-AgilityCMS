import crypto from 'crypto'
import agilityContentSync from '@agility/content-sync'
import agilityFileSystem from "@agility/content-sync/src/store-interface-filesystem"

import agilityConfig from './agility.config'
import GlobalHeader from './components/GlobalHeader'


//Agility API stuff
const previewAPIKey = agilityConfig.previewAPIKey;
const fetchAPIKey = agilityConfig.fetchAPIKey;
const guid = agilityConfig.guid;
const languageCode = agilityConfig.languageCode;
const channelName = agilityConfig.channelName;
const securityKey = agilityConfig.securityKey;


const getSyncClient = ({ isPreview, apiKey }) => {

	const cachePath = `node_modules/@agility/content-sync/cache/${isPreview ? 'preview' : 'live'}`

	return agilityContentSync.getSyncClient({
		guid: guid,
		apiKey: apiKey,
		isPreview: isPreview,
		languages: [languageCode],
		channels: [channelName],
		store: {
			interface: agilityFileSystem,
			options: {
				rootPath: cachePath
			}
		}
	})
}


export async function getAgilityPageProps({ context }) {

	//determine if we are in preview mode
	let apiKey = fetchAPIKey;

	const isDevelopmentMode = process.env.NODE_ENV === "development";
	const isPreview = (context.preview || isDevelopmentMode ? true : false);

	if (isPreview) {
		apiKey = previewAPIKey
	}

	const agilitySyncClient = getSyncClient({
		apiKey: apiKey,
		isPreview: isPreview
	});

	let path = '/';
	if (context.params) {
		//build path by iterating through slugs
		path = '';
		context.params.slug.map(slug => {
			path += '/' + slug
		})
	}


	//only sync if we are in preview mode
	if (isPreview) {
		console.log(`Agility CMS => Syncing ${isPreview ? "Preview" : "Live"} Mode`)
		await agilitySyncClient.runSync();
	}


	console.log(`Agility CMS => Getting page props for '${path}'...`);


	//get sitemap
	const sitemap = await agilitySyncClient.store.getSitemap({ channelName, languageCode });

	let pageInSitemap = sitemap[path];
	let page = null;


	if (path === '/') {
		let firstPagePathInSitemap = Object.keys(sitemap)[0];
		pageInSitemap = sitemap[firstPagePathInSitemap];
	}

	if (pageInSitemap) {
		//get the page
		page = await agilitySyncClient.store.getPage({
			pageID: pageInSitemap.pageID,
			languageCode: languageCode
		});

	} else {
		//Could not find page
		console.error('page [' + path + '] not found in sitemap.')

		//TODO: Redirect to 404 page
	}

	if (!page) {
		console.error('page [' + path + '] not found in getpage method.')
	}


	//resolve the page template
	const pageTemplateName = page.templateName.replace(/[^0-9a-zA-Z]/g, '');

	//resolve the modules per content zone
	await asyncForEach(Object.keys(page.zones), async (zoneName) => {

		let modules = [];

		//grab the modules for this content zone
		const modulesForThisContentZone = page.zones[zoneName];

		//loop through the zone's modules
		await asyncForEach(modulesForThisContentZone, async (moduleItem) => {

			//find the react component to use for the module
			const ModuleComponentToRender = require('./modules/' + moduleItem.module + '.js').default;

			if (ModuleComponentToRender) {

				//resolve any additional data for the modules
				let moduleData = null;

				if (ModuleComponentToRender.getCustomInitialProps) {
					//we have some additional data in the module we'll need, execute that method now, so it can be included in SSG
					console.log(`Agility CMS => Fetching additional data via getCustomInitialProps for ${moduleItem.module}...`);
					moduleData = await ModuleComponentToRender.getCustomInitialProps({
						item: moduleItem.item,
						agility: agilitySyncClient.store,
						languageCode: languageCode,
						channelName: channelName,
						pageInSitemap: pageInSitemap
					});
				}

				//if we have additional module data, then add it to the module props using 'customData'
				if (moduleData != null) {
					moduleItem.item.customData = moduleData;
				}

				modules.push({
					moduleName: moduleItem.module,
					item: moduleItem.item,
				})

			} else {
				console.error(`No react component found for the module "${moduleItem.module}". Cannot render module.`);
			}
		})


		//store as dictionary
		page.zones[zoneName] = modules;

	})

	//resolve data for other shared components
	const globalHeaderProps = await GlobalHeader.getCustomInitialProps({ agility: agilitySyncClient.store, languageCode: languageCode, channelName: channelName });

	//TODO: should reduce this response to only include fields that are used in direct output
	return {
		sitemapNode: pageInSitemap,
		page: page,
		pageTemplateName: pageTemplateName,
		globalHeaderProps: globalHeaderProps,
		languageCode: languageCode,
		channelName: channelName,
		isPreview: (context.preview ? true : false)
	}
}

const asyncForEach = async (array, callback) => {
	for (let index = 0; index < array.length; index++) {
		await callback(array[index], index, array);
	}
}


export async function getAgilityPaths() {


	console.log(`Agility CMS => Fetching sitemap for getAgilityPaths...`);

	//determine if we are in preview mode
	const apiKey = fetchAPIKey;
	const isPreview = false;

	if (isPreview) {
		apiKey = previewAPIKey
	}

	const agilitySyncClient = getSyncClient({
		apiKey: apiKey,
		isPreview: isPreview
	});

	console.log(`Agility CMS => Syncing ${isPreview ? "Preview" : "Live"} Mode`)

	await agilitySyncClient.runSync();


	const sitemapFlat = await agilitySyncClient.store.getSitemap({
		channelName,
		languageCode
	})

	return Object.keys(sitemapFlat).map(s => {
		//returns an array of paths as a string (i.e.  ['/home', '/posts'] as opposed to [{ params: { slug: 'home'}}]))
		return s;
	})
}



export async function validatePreview({ agilityPreviewKey, slug }) {
	//Validate the preview key
	if (!agilityPreviewKey) {
		return {
			error: true,
			message: `Missing agilitypreviewkey.`
		}
	}

	//sanitize incoming key (replace spaces with '+')
	if (agilityPreviewKey.indexOf(` `) > -1) {
		agilityPreviewKey = agilityPreviewKey.split(` `).join(`+`);
	}

	//compare the preview key being used
	const correctPreviewKey = generatePreviewKey();

	if (agilityPreviewKey !== correctPreviewKey) {
		return {
			error: true,
			message: `Invalid agilitypreviewkey.`
			//message: `Invalid agilitypreviewkey. Incoming key is=${agilityPreviewKey} compared to=${correctPreviewKey}...`
		}
	}

	const validateSlugResponse = await validateSlugForPreview({ slug });

	if (validateSlugResponse.error) {
		//kickout
		return validateSlugResponse;
	}

	//return success
	return {
		error: false,
		message: null
	}

}

export async function validateSlugForPreview({ slug }) {
	//Check that the requested page exists, if not return a 401

	return {
		error: false,
		message: null
	}



	console.log("Validate Slug", slug)

	const agilitySyncClient = getSyncClient({
		apiKey: previewAPIKey,
		isPreview: true
	});


	await agilitySyncClient.runSync();

	console.log("get sync client", previewAPIKey)

	const sitemapFlat = await agilitySyncClient.store.getSitemap({
		channelName,
		languageCode
	})

	console.log("Sitemap Flat", sitemapFlat)

	const pageInSitemap = sitemapFlat[slug];

	if (!pageInSitemap && slug !== `/`) {
		return {
			error: true,
			message: `Invalid page. '${slug}' was not found in the sitemap.`
		}
	}

	return {
		error: false,
		message: null
	}
}

export function generatePreviewKey() {
	//the string we want to encode
	const str = `-1_${securityKey}_Preview`;

	//build our byte array
	let data = [];
	for (var i = 0; i < str.length; ++i) {
		data.push(str.charCodeAt(i));
		data.push(0);
	}

	//convert byte array to buffer
	const strBuffer = Buffer.from(data);

	//encode it!
	const previewKey = crypto.createHash('sha512').update(strBuffer).digest('base64');
	return previewKey;
}
