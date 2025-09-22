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

// Instagram Scraper Class
class InstagramScraper {
    constructor() {
        this.retryAttempts = 3;
        this.retryDelay = 2000;
    }

    async getMediaInfo(url, attempt = 1) {
        try {
            const postId = extractPostId(url);
            if (!postId) throw new Error('Invalid Instagram URL format');

            // Check cache first
            const cacheKey = `media_${postId}`;
            const cachedResult = this.getFromCache(cacheKey);
            if (cachedResult) return cachedResult;

            // Method 1: Direct scraping
            let result = await this.scrapeDirectly(url);
            
            if (!result && attempt <= this.retryAttempts) {
                await delay(this.retryDelay * attempt);
                return this.getMediaInfo(url, attempt + 1);
            }

            if (result) {
                this.setCache(cacheKey, result);
                return result;
            }

            throw new Error('Failed to extract media information');

        } catch (error) {
            if (attempt <= this.retryAttempts) {
                await delay(this.retryDelay * attempt);
                return this.getMediaInfo(url, attempt + 1);
            }
            throw error;
        }
    }

    getFromCache(key) {
        const item = cache.get(key);
        if (item && Date.now() - item.timestamp < CACHE_TTL) {
            return item.data;
        }
        cache.delete(key);
        return null;
    }

    setCache(key, data) {
        cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    async scrapeDirectly(url) {
        try {
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
                timeout: 15000
            });

            return this.extractMediaFromHtml(response.data);
        } catch (error) {
            console.error('Direct scraping failed:', error.message);
            return null;
        }
    }

    extractMediaFromHtml(html) {
        try {
            const $ = cheerio.load(html);
            
            // Look for JSON data in script tags
            const scripts = $('script[type="application/ld+json"]');
            let mediaData = null;

            scripts.each((i, script) => {
                try {
                    const jsonData = JSON.parse($(script).html());
                    if (jsonData.video && jsonData.video.contentUrl) {
                        mediaData = {
                            type: 'video',
                            url: jsonData.video.contentUrl,
                            thumbnail: jsonData.video.thumbnailUrl,
                            title: jsonData.headline || jsonData.name || 'Instagram Video',
                            description: jsonData.description || '',
                            author: jsonData.author ? jsonData.author.name : 'Unknown',
                            uploadDate: jsonData.uploadDate || new Date().toISOString()
                        };
                        return false; // break the loop
                    }
                } catch (e) {
                    // Continue to next script
                }
            });

            // Fallback: Look for shared data in window._sharedData
            if (!mediaData) {
                const sharedDataMatch = html.match(/window\._sharedData\s*=\s*({.+?});/);
                if (sharedDataMatch) {
                    try {
                        const sharedData = JSON.parse(sharedDataMatch[1]);
                        mediaData = this.extractFromSharedData(sharedData);
                    } catch (e) {
                        console.error('Error parsing shared data:', e);
                    }
                }
            }

            // Another fallback: Look for additional window data
            if (!mediaData) {
                const additionalDataMatch = html.match(/window\.__additionalDataLoaded\(['"].*?['"],\s*({.+?})\);/);
                if (additionalDataMatch) {
                    try {
                        const additionalData = JSON.parse(additionalDataMatch[1]);
                        mediaData = this.extractFromAdditionalData(additionalData);
                    } catch (e) {
                        console.error('Error parsing additional data:', e);
                    }
                }
            }

            return mediaData;
        } catch (error) {
            console.error('HTML extraction failed:', error);
            return null;
        }
    }

    extractFromSharedData(sharedData) {
        try {
            const entryData = sharedData.entry_data;
            let mediaInfo = null;

            if (entryData.PostPage && entryData.PostPage[0]) {
                const media = entryData.PostPage[0].graphql.shortcode_media;
                mediaInfo = this.processMediaObject(media);
            }

            return mediaInfo;
        } catch (error) {
            console.error('Error extracting from shared data:', error);
            return null;
        }
    }

    extractFromAdditionalData(additionalData) {
        try {
            if (additionalData.graphql && additionalData.graphql.shortcode_media) {
                return this.processMediaObject(additionalData.graphql.shortcode_media);
            }
            return null;
        } catch (error) {
            console.error('Error extracting from additional data:', error);
            return null;
        }
        }
    }

    processMediaObject(media) {
        try {
            const result = {
                type: media.is_video ? 'video' : 'image',
                postId: media.shortcode,
                author: media.owner.username,
                caption: media.edge_media_to_caption.edges[0]?.node.text || '',
                likes: media.edge_media_preview_like.count,
                comments: media.edge_media_to_comment.count,
                timestamp: media.taken_at_timestamp,
                isCarousel: media.__typename === 'GraphSidecar'
            };

            if (media.is_video) {
                result.videoUrl = media.video_url;
                result.thumbnail = media.display_url;
                result.duration = media.video_duration;
                result.viewCount = media.video_view_count;
                
                result.qualities = [{
                    quality: 'original',
                    url: media.video_url,
                    width: media.dimensions.width,
                    height: media.dimensions.height
                }];
            } else {
                result.imageUrl = media.display_url;
                result.images = [{
                    quality: 'original',
                    url: media.display_url,
                    width: media.dimensions.width,
                    height: media.dimensions.height
                }];
            }

            // Handle carousel posts
            if (media.__typename === 'GraphSidecar' && media.edge_sidecar_to_children) {
                result.items = media.edge_sidecar_to_children.edges.map(edge => {
                    const node = edge.node;
                    return {
                        type: node.is_video ? 'video' : 'image',
                        url: node.is_video ? node.video_url : node.display_url,
                        thumbnail: node.display_url,
                        dimensions: node.dimensions
                    };
                });
            }

            return result;
        } catch (error) {
            console.error('Error processing media object:', error);
            return null;
        }
    }
}

// Initialize scraper
const scraper = new InstagramScraper();

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
                platform: 'Vercel Serverless'
            });
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

            const mediaInfo = await scraper.getMediaInfo(url);

            if (!mediaInfo) {
                return res.status(404).json({
                    error: 'Could not extract media information from URL',
                    code: 'EXTRACTION_FAILED',
                    url: url
                });
            }

            return res.status(200).json({
                success: true,
                data: mediaInfo,
                timestamp: new Date().toISOString()
            });
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
                    
                    const mediaInfo = await scraper.getMediaInfo(url);
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

            const mediaInfo = await scraper.getMediaInfo(url);
            
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
                'GET /api/v1/info?url=<instagram_url> - Get media info'
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
