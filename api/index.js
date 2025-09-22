// api/index.js - Vercel Serverless Function for Instagram Video Downloader
const axios = require('axios');
const cheerio = require('cheerio');
const validator = require('validator');

// Simple in-memory cache for serverless (Vercel handles caching between requests)
const cache = new Map();
const CACHE_TTL = 600000; // 10 minutes in milliseconds

// User agents for rotation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

// Utility Functions
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const extractPostId = (url) => {
    const patterns = [
        /\/p\/([A-Za-z0-9_-]+)/,
        /\/reel\/([A-Za-z0-9_-]+)/,
        /\/tv\/([A-Za-z0-9_-]+)/,
        /instagram\.com\/([A-Za-z0-9_.]+)\/p\/([A-Za-z0-9_-]+)/,
        /instagram\.com\/([A-Za-z0-9_.]+)\/reel\/([A-Za-z0-9_-]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[match.length - 1];
    }
    return null;
};

const validateInstagramUrl = (url) => {
    if (!validator.isURL(url)) return false;
    return /instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]+/.test(url) || 
           /instagram\.com\/[A-Za-z0-9_.]+\/(p|reel)\/[A-Za-z0-9_-]+/.test(url);
};

// Helper functions for cache
const getFromCache = (key) => {
    const item = cache.get(key);
    if (item && Date.now() - item.timestamp < CACHE_TTL) {
        return item.data;
    }
    cache.delete(key);
    return null;
};

const setCache = (key, data) => {
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
};

// Main scraping functions
const scrapeDirectly = async (url) => {
    try {
        console.log('Making request to Instagram...');
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: function (status) {
                return status < 500; // Accept anything less than 500 as success for now
            }
        });

        console.log('Instagram response:', {
            status: response.status,
            contentType: response.headers['content-type'],
            contentLength: response.data.length
        });

        // Check for common Instagram error responses
        if (response.status === 404) {
            throw new Error('Instagram post not found (404) - post may be deleted or private');
        }
        
        if (response.status === 429) {
            throw new Error('Instagram rate limiting detected (429) - too many requests');
        }
        
        if (response.status >= 400) {
            throw new Error(`Instagram returned error status: ${response.status}`);
        }

        // Check if we got redirected to login page
        if (response.data.includes('login_and_signup_page') || 
            response.data.includes('"require_login"') ||
            response.data.includes('login/?next=')) {
            throw new Error('Instagram requires login - post may be private or region restricted');
        }

        // Check for age restriction
        if (response.data.includes('age_restricted') || response.data.includes('sensitive_content')) {
            throw new Error('Instagram post is age restricted or contains sensitive content');
        }

        const result = extractMediaFromHtml(response.data);
        
        if (!result) {
            console.log('Failed to extract media from HTML');
            // Log a sample of the HTML for debugging
            const htmlSample = response.data.substring(0, 1000);
            console.log('HTML sample:', htmlSample);
        }
        
        return result;

    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error('Request timeout - Instagram may be slow or blocking');
        } else if (error.code === 'ENOTFOUND') {
            console.error('DNS resolution failed - network issue');
        } else {
            console.error('Direct scraping failed:', error.message);
        }
        return null;
    }
};

const extractMediaFromHtml = (html) => {
    try {
        const $ = cheerio.load(html);
        console.log('HTML content length:', html.length);
        
        // Method 1: Look for JSON-LD data in script tags
        const scripts = $('script[type="application/ld+json"]');
        let mediaData = null;

        scripts.each((i, script) => {
            try {
                const jsonData = JSON.parse($(script).html());
                if (jsonData.video && jsonData.video.contentUrl) {
                    mediaData = {
                        type: 'video',
                        videoUrl: jsonData.video.contentUrl,
                        thumbnail: jsonData.video.thumbnailUrl,
                        title: jsonData.headline || jsonData.name || 'Instagram Video',
                        caption: jsonData.description || '',
                        author: jsonData.author ? jsonData.author.name : 'Unknown',
                        uploadDate: jsonData.uploadDate || new Date().toISOString()
                    };
                    console.log('Found video data in JSON-LD');
                    return false; // break the loop
                }
            } catch (e) {
                // Continue to next script
            }
        });

        // Method 2: Look for shared data in window._sharedData
        if (!mediaData) {
            const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});/);
            if (sharedDataMatch) {
                try {
                    const sharedData = JSON.parse(sharedDataMatch[1]);
                    console.log('Found window._sharedData');
                    mediaData = extractFromSharedData(sharedData);
                } catch (e) {
                    console.error('Error parsing shared data:', e.message);
                }
            }
        }

        // Method 3: Look for additional window data patterns
        if (!mediaData) {
            const patterns = [
                /window\.__additionalDataLoaded\(['"].*?['"],\s*({.+?})\);/,
                /window\.__d\(['"]PolarisPostRoot\.react['"],\s*function[^}]+\},\s*({.+?})\);/,
                /"require":\[\["PolarisPostRoot",.*?({.+?"shortcode_media".+?})/
            ];

            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match) {
                    try {
                        const data = JSON.parse(match[1]);
                        console.log('Found data in pattern match');
                        mediaData = extractFromAdditionalData(data);
                        if (mediaData) break;
                    } catch (e) {
                        console.error('Error parsing pattern data:', e.message);
                    }
                }
            }
        }

        // Method 4: Search for any JSON containing Instagram media data
        if (!mediaData) {
            const jsonRegex = /"shortcode_media":\s*({[^}]+(?:{[^}]*}[^}]*)*})/g;
            let match;
            while ((match = jsonRegex.exec(html)) !== null) {
                try {
                    const mediaObj = JSON.parse(match[1]);
                    console.log('Found shortcode_media in JSON');
                    mediaData = processMediaObject(mediaObj);
                    if (mediaData) break;
                } catch (e) {
                    // Continue searching
                }
            }
        }

        // Method 5: Look for meta tags
        if (!mediaData) {
            const videoUrl = $('meta[property="og:video"]').attr('content') || 
                           $('meta[property="og:video:url"]').attr('content');
            const imageUrl = $('meta[property="og:image"]').attr('content');
            const title = $('meta[property="og:title"]').attr('content');
            const description = $('meta[property="og:description"]').attr('content');

            if (videoUrl || imageUrl) {
                console.log('Found media data in meta tags');
                mediaData = {
                    type: videoUrl ? 'video' : 'image',
                    videoUrl: videoUrl,
                    imageUrl: imageUrl,
                    thumbnail: imageUrl,
                    title: title || 'Instagram Post',
                    caption: description || '',
                    author: 'Unknown'
                };
            }
        }

        // Log what we found
        if (mediaData) {
            console.log('Successfully extracted media data:', {
                type: mediaData.type,
                hasUrl: !!(mediaData.videoUrl || mediaData.imageUrl),
                hasCaption: !!mediaData.caption
            });
        } else {
            console.log('No media data found in HTML');
            // Log some debugging info
            console.log('Page title:', $('title').text());
            console.log('Meta description:', $('meta[name="description"]').attr('content'));
            console.log('Has script tags:', $('script').length);
        }

        return mediaData;
    } catch (error) {
        console.error('HTML extraction failed:', error);
        return null;
    }
};

const extractFromSharedData = (sharedData) => {
    try {
        const entryData = sharedData.entry_data;
        let mediaInfo = null;

        if (entryData.PostPage && entryData.PostPage[0]) {
            const media = entryData.PostPage[0].graphql.shortcode_media;
            mediaInfo = processMediaObject(media);
        }

        return mediaInfo;
    } catch (error) {
        console.error('Error extracting from shared data:', error);
        return null;
    }
};

const extractFromAdditionalData = (additionalData) => {
    try {
        // Multiple ways to find the media data
        let media = null;
        
        // Method 1: Direct path
        if (additionalData.graphql && additionalData.graphql.shortcode_media) {
            media = additionalData.graphql.shortcode_media;
        }
        // Method 2: Look for any shortcode_media in the object
        else if (additionalData.shortcode_media) {
            media = additionalData.shortcode_media;
        }
        // Method 3: Deep search for shortcode_media
        else {
            const searchForMedia = (obj) => {
                if (typeof obj !== 'object' || obj === null) return null;
                
                if (obj.shortcode_media) return obj.shortcode_media;
                
                for (const key in obj) {
                    if (key === 'shortcode_media') return obj[key];
                    if (typeof obj[key] === 'object') {
                        const result = searchForMedia(obj[key]);
                        if (result) return result;
                    }
                }
                return null;
            };
            
            media = searchForMedia(additionalData);
        }
        
        if (media) {
            console.log('Found media object in additional data');
            return processMediaObject(media);
        }
        
        return null;
    } catch (error) {
        console.error('Error extracting from additional data:', error);
        return null;
    }
};

const processMediaObject = (media) => {
    try {
        console.log('Processing media object:', {
            has_shortcode: !!media.shortcode,
            has_owner: !!media.owner,
            is_video: media.is_video,
            typename: media.__typename
        });

        const result = {
            type: media.is_video ? 'video' : 'image',
            postId: media.shortcode || media.id || 'unknown',
            author: media.owner?.username || 'unknown',
            caption: '',
            likes: 0,
            comments: 0,
            timestamp: media.taken_at_timestamp || Date.now(),
            isCarousel: media.__typename === 'GraphSidecar'
        };

        // Extract caption safely
        try {
            if (media.edge_media_to_caption?.edges?.[0]?.node?.text) {
                result.caption = media.edge_media_to_caption.edges[0].node.text;
            } else if (media.caption) {
                result.caption = media.caption;
            }
        } catch (e) {
            console.log('Could not extract caption:', e.message);
        }

        // Extract engagement safely
        try {
            result.likes = media.edge_media_preview_like?.count || media.like_count || 0;
            result.comments = media.edge_media_to_comment?.count || media.comment_count || 0;
        } catch (e) {
            console.log('Could not extract engagement:', e.message);
        }

        if (media.is_video) {
            result.videoUrl = media.video_url;
            result.thumbnail = media.display_url || media.thumbnail_url;
            result.duration = media.video_duration || 0;
            result.viewCount = media.video_view_count || 0;
            
            // Add quality options
            result.qualities = [];
            if (media.video_url) {
                result.qualities.push({
                    quality: 'original',
                    url: media.video_url,
                    width: media.dimensions?.width || 0,
                    height: media.dimensions?.height || 0
                });
            }
        } else {
            result.imageUrl = media.display_url || media.thumbnail_url;
            result.images = [];
            if (media.display_url) {
                result.images.push({
                    quality: 'original',
                    url: media.display_url,
                    width: media.dimensions?.width || 0,
                    height: media.dimensions?.height || 0
                });
            }
        }

        // Handle carousel posts safely
        if (media.__typename === 'GraphSidecar' && media.edge_sidecar_to_children?.edges) {
            result.items = media.edge_sidecar_to_children.edges.map(edge => {
                const node = edge.node;
                return {
                    type: node.is_video ? 'video' : 'image',
                    url: node.is_video ? node.video_url : node.display_url,
                    thumbnail: node.display_url,
                    dimensions: node.dimensions || { width: 0, height: 0 }
                };
            });
        }

        console.log('Successfully processed media object:', {
            type: result.type,
            hasUrl: !!(result.videoUrl || result.imageUrl),
            hasCaption: !!result.caption,
            captionLength: result.caption.length
        });

        return result;
    } catch (error) {
        console.error('Error processing media object:', error);
        
        // Return minimal object if we have at least some data
        if (media.video_url || media.display_url) {
            return {
                type: media.is_video ? 'video' : 'image',
                postId: media.shortcode || 'unknown',
                author: 'unknown',
                caption: '',
                videoUrl: media.video_url,
                imageUrl: media.display_url,
                thumbnail: media.display_url
            };
        }
        
        return null;
    }
};

// Main media extraction function
const getMediaInfo = async (url, attempt = 1) => {
    try {
        console.log(`Attempt ${attempt} for URL:`, url);
        
        const postId = extractPostId(url);
        if (!postId) {
            throw new Error('Invalid Instagram URL format - could not extract post ID');
        }
        
        console.log('Extracted post ID:', postId);

        // Check cache first
        const cacheKey = `media_${postId}`;
        const cachedResult = getFromCache(cacheKey);
        if (cachedResult) {
            console.log('Returning cached result');
            return cachedResult;
        }

        // Try direct scraping
        console.log('Attempting direct scraping...');
        let result = await scrapeDirectly(url);
        
        if (!result && attempt <= 3) {
            console.log(`Attempt ${attempt} failed, retrying...`);
            await delay(2000 * attempt);
            return getMediaInfo(url, attempt + 1);
        }

        if (result) {
            console.log('Successfully extracted media info');
            setCache(cacheKey, result);
            return result;
        }

        // If we get here, all extraction methods failed
        const errorMsg = `Failed to extract media information after ${attempt} attempts. Instagram may have changed their structure or the post may be private/deleted.`;
        console.error(errorMsg);
        throw new Error(errorMsg);

    } catch (error) {
        console.error(`getMediaInfo error (attempt ${attempt}):`, error.message);
        
        if (attempt <= 3) {
            console.log(`Retrying attempt ${attempt + 1}...`);
            await delay(2000 * attempt);
            return getMediaInfo(url, attempt + 1);
        }
        
        // After all retries failed, throw with more context
        throw new Error(`Failed to extract media information: ${error.message}. This could be due to: 1) Private/deleted post, 2) Instagram blocking the request, 3) Changed Instagram structure, 4) Invalid URL format.`);
    }
};

// CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Main handler function
module.exports = async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        Object.keys(corsHeaders).forEach(key => {
            res.setHeader(key, corsHeaders[key]);
        });
        return res.status(200).json({ success: true });
    }

    // Set CORS headers
    Object.keys(corsHeaders).forEach(key => {
        res.setHeader(key, corsHeaders[key]);
    });

    const { url: requestUrl, method } = req;
    const urlPath = requestUrl.replace(/^\/api/, '');

    try {
        // Health check endpoint
        if (urlPath === '/health' || requestUrl === '/health') {
            return res.status(200).json({
                status: 'healthy',
                timestamp: new Date().toISOString(),
                version: '1.0.0',
                platform: 'Vercel Serverless',
                features: ['video_download', 'image_download', 'batch_processing', 'reel_captions']
            });
        }

        // Debug endpoint for testing specific URLs
        if ((urlPath.startsWith('/v1/debug') || requestUrl.includes('/debug')) && method === 'GET') {
            const { url } = req.query;

            if (!url) {
                return res.status(400).json({
                    error: 'URL parameter is required for debug endpoint',
                    code: 'MISSING_URL'
                });
            }

            try {
                console.log('=== DEBUG MODE FOR URL ===', url);
                const postId = extractPostId(url);
                
                const debugInfo = {
                    url: url,
                    postId: postId,
                    isValidUrl: validateInstagramUrl(url),
                    timestamp: new Date().toISOString()
                };

                // Try to get basic page info
                try {
                    const response = await axios.get(url, {
                        headers: { 'User-Agent': getRandomUserAgent() },
                        timeout: 10000
                    });
                    
                    debugInfo.httpStatus = response.status;
                    debugInfo.contentLength = response.data.length;
                    debugInfo.hasLoginRedirect = response.data.includes('login_and_signup_page');
                    debugInfo.hasAgeRestriction = response.data.includes('age_restricted');
                } catch (e) {
                    debugInfo.requestError = e.message;
                }

                return res.status(200).json({
                    success: true,
                    debug: debugInfo
                });
            } catch (error) {
                return res.status(500).json({
                    success: false,
                    error: 'Debug failed',
                    message: error.message
                });
            }
        }

        // Download endpoint
        if ((urlPath.startsWith('/v1/download') || requestUrl.includes('/download')) && method === 'GET') {
            const { url } = req.query;

            if (!url) {
                return res.status(400).json({
                    error: 'URL parameter is required',
                    code: 'MISSING_URL',
                    example: '/api/v1/download?url=https://www.instagram.com/p/ABC123'
                });
            }

            if (!validateInstagramUrl(url)) {
                return res.status(400).json({
                    error: 'Invalid Instagram URL format',
                    code: 'INVALID_URL',
                    supportedFormats: [
                        'https://www.instagram.com/p/POST_ID/',
                        'https://www.instagram.com/reel/REEL_ID/',
                        'https://www.instagram.com/tv/TV_ID/'
                    ]
                });
            }

            try {
                const mediaInfo = await getMediaInfo(url);

                if (!mediaInfo) {
                    return res.status(404).json({
                        error: 'Could not extract media information from URL',
                        code: 'EXTRACTION_FAILED',
                        url: url,
                        possibleReasons: [
                            'Post may be private or deleted',
                            'Instagram may be blocking requests',
                            'Post may be age-restricted',
                            'Instagram structure may have changed'
                        ],
                        suggestion: 'Try the debug endpoint: /api/v1/debug?url=YOUR_URL'
                    });
                }

                return res.status(200).json({
                    success: true,
                    data: mediaInfo,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('Download endpoint error:', error);
                
                return res.status(500).json({
                    error: 'Failed to process Instagram URL',
                    code: 'PROCESSING_ERROR',
                    message: error.message,
                    url: url,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // Batch download endpoint
        if ((urlPath.startsWith('/v1/download/batch') || requestUrl.includes('/download/batch')) && method === 'POST') {
            const { urls } = req.body;

            if (!urls || !Array.isArray(urls)) {
                return res.status(400).json({
                    error: 'URLs array is required in request body',
                    code: 'MISSING_URLS',
                    example: { urls: ['https://www.instagram.com/p/ABC123', 'https://www.instagram.com/reel/XYZ789'] }
                });
            }

            if (urls.length > 10) {
                return res.status(400).json({
                    error: 'Maximum 10 URLs allowed per batch request',
                    code: 'TOO_MANY_URLS',
                    limit: 10
                });
            }

            const results = await Promise.allSettled(
                urls.map(async (url) => {
                    if (!validateInstagramUrl(url)) {
                        throw new Error(`Invalid URL format: ${url}`);
                    }
                    
                    const mediaInfo = await getMediaInfo(url);
                    return { url, data: mediaInfo };
                })
            );

            const response = {
                success: true,
                total: urls.length,
                successful: 0,
                failed: 0,
                results: [],
                timestamp: new Date().toISOString()
            };

            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    response.successful++;
                    response.results.push({
                        url: urls[index],
                        success: true,
                        data: result.value.data
                    });
                } else {
                    response.failed++;
                    response.results.push({
                        url: urls[index],
                        success: false,
                        error: result.reason.message
                    });
                }
            });

            return res.status(200).json(response);
        }

        // Info endpoint (metadata only)
        if ((urlPath.startsWith('/v1/info') || requestUrl.includes('/info')) && method === 'GET') {
            const { url } = req.query;

            if (!url || !validateInstagramUrl(url)) {
                return res.status(400).json({
                    error: 'Valid Instagram URL is required',
                    code: 'INVALID_URL'
                });
            }

            const mediaInfo = await getMediaInfo(url);
            
            if (mediaInfo) {
                // Remove download URLs for info-only endpoint
                const infoOnly = { ...mediaInfo };
                delete infoOnly.videoUrl;
                delete infoOnly.imageUrl;
                delete infoOnly.qualities;
                delete infoOnly.images;
                
                if (infoOnly.items) {
                    infoOnly.items = infoOnly.items.map(item => {
                        const itemCopy = { ...item };
                        delete itemCopy.url;
                        return itemCopy;
                    });
                }
                
                return res.status(200).json({
                    success: true,
                    data: infoOnly,
                    timestamp: new Date().toISOString()
                });
            } else {
                return res.status(404).json({
                    error: 'Media not found or could not be processed',
                    code: 'NOT_FOUND'
                });
            }
        }

        // 404 for unknown endpoints
        return res.status(404).json({
            error: 'Endpoint not found',
            code: 'NOT_FOUND',
            availableEndpoints: [
                'GET /health - Check API health',
                'GET /api/v1/download?url=<instagram_url> - Download media',
                'POST /api/v1/download/batch - Batch download',
                'GET /api/v1/info?url=<instagram_url> - Get media info',
                'GET /api/v1/debug?url=<instagram_url> - Debug URL extraction'
            ],
            requestedPath: requestUrl,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('API error:', error);
        
        return res.status(500).json({
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
};
