/** Sub-Store Workers Express 适配层 */

import { ENV } from './open-api';

export default function express({ substore: $ }) {
    const DEFAULT_HEADERS = {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD',
        'Access-Control-Allow-Headers':
            'Origin, X-Requested-With, Content-Type, Accept, Authorization',
        'X-Powered-By': 'Sub-Store-Workers',
    };

    // 路由处理器
    const handlers = [];
    // 中间件栈
    const middlewares = [];

    // HTTP 方法
    const METHODS_NAMES = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'PATCH',
        'OPTIONS',
        'HEAD',
        'ALL',
    ];

    const app = {};

    // 注册中间件
    app.use = (fn) => {
        middlewares.push(fn);
    };

    // 注册路由方法
    METHODS_NAMES.forEach((method) => {
        app[method.toLowerCase()] = (pattern, callback) => {
            handlers.push({ method, pattern, callback });
        };
    });

    // 链式路由
    app.route = (pattern) => {
        const chainApp = {};
        METHODS_NAMES.forEach((method) => {
            chainApp[method.toLowerCase()] = (callback) => {
                handlers.push({ method, pattern, callback });
                return chainApp;
            };
        });
        return chainApp;
    };

    // 空操作
    app.start = () => {};

    /** 处理请求 */
    app.handleRequest = async (request) => {
        // CORS 预检已在 index.js 外层处理，此处直接进入路由

        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        // 安全解码 pathname；遇到错误的 %xx 序列降级到原值，不要让请求 500
        let path;
        try {
            path = decodeURIComponent(url.pathname);
        } catch (e) {
            path = url.pathname;
        }
        const query = {};
        url.searchParams.forEach((value, key) => {
            // 多值同名参数：保留最后一个（与上游解析行为一致）
            query[key] = value;
        });

        // 解析请求体
        let body = null;
        if (!['GET', 'HEAD'].includes(method)) {
            const contentType = request.headers.get('content-type') || '';
            if (contentType.includes('json')) {
                try {
                    body = await request.json();
                } catch (e) {
                    body = null;
                }
            } else {
                try {
                    body = await request.text();
                } catch (e) {
                    body = null;
                }
            }
        }

        // 转换请求头
        const headers = {};
        request.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
        });

        // 构建 req 对象
        const req = {
            method,
            url: request.url,
            path,
            query,
            params: {},
            headers,
            body,
            _parsedUrl: { pathname: path },
        };

        // 构建 res 对象
        let responded = false;
        let responseResolve;
        const responsePromise = new Promise((resolve) => {
            responseResolve = resolve;
        });

        const resHeaders = { ...DEFAULT_HEADERS };
        let resStatusCode = 200;

        const res = {
            req, // 反向引用
            status(code) {
                resStatusCode = code;
                return this;
            },
            set(key, val) {
                if (typeof key === 'object' && key !== null) {
                    Object.assign(resHeaders, key);
                } else {
                    resHeaders[key] = val;
                }
                return this;
            },
            setHeader(key, val) {
                resHeaders[key] = val;
                return this;
            },
            removeHeader(key) {
                delete resHeaders[key];
                return this;
            },
            send(body = '') {
                if (responded) return;
                responded = true;
                // 如果 body 是 Uint8Array / ArrayBuffer / Blob 直接透传，避免被字符串化
                let payload = body;
                if (
                    body != null &&
                    typeof body !== 'string' &&
                    !(body instanceof Uint8Array) &&
                    !(body instanceof ArrayBuffer) &&
                    !(typeof Blob !== 'undefined' && body instanceof Blob) &&
                    !(typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
                ) {
                    payload = String(body);
                }
                responseResolve(
                    new Response(payload, {
                        status: resStatusCode,
                        headers: resHeaders,
                    }),
                );
            },
            end() {
                this.send('');
            },
            json(data) {
                resHeaders['Content-Type'] = 'application/json;charset=UTF-8';
                this.send(JSON.stringify(data));
            },
            html(data) {
                resHeaders['Content-Type'] = 'text/html;charset=UTF-8';
                this.send(data);
            },
        };

        // 执行中间件链
        const runMiddlewares = async (idx) => {
            if (idx >= middlewares.length) {
                // 分发到路由
                await dispatchRoute(method, path, query, req, res);
                return;
            }
            const mw = middlewares[idx];
            await new Promise((resolve, reject) => {
                try {
                    const result = mw(req, res, () => resolve());
                    if (result && typeof result.then === 'function') {
                        result.then(() => resolve()).catch(reject);
                    }
                } catch (e) {
                    reject(e);
                }
            });
            if (!responded) {
                await runMiddlewares(idx + 1);
            }
        };

        try {
            await runMiddlewares(0);
        } catch (e) {
            if (!responded) {
                responseResolve(
                    new Response(
                        JSON.stringify({
                            status: 'failed',
                            message: `Internal Server Error: ${e.message || e}`,
                        }),
                        {
                            status: 500,
                            headers: {
                                ...DEFAULT_HEADERS,
                                'Content-Type': 'application/json;charset=UTF-8',
                            },
                        },
                    ),
                );
            }
        }

        // 未匹配返回 404
        if (!responded) {
            responseResolve(
                new Response(
                    JSON.stringify({
                        status: 'failed',
                        message: 'ERROR: 404 not found',
                    }),
                    {
                        status: 404,
                        headers: {
                            ...DEFAULT_HEADERS,
                            'Content-Type': 'application/json;charset=UTF-8',
                        },
                    },
                ),
            );
        }

        return responsePromise;
    };

    // 匹配最优路由
    async function dispatchRoute(method, path, query, req, res) {
        let handler = null;
        let bestScore = -1;

        for (let i = 0; i < handlers.length; i++) {
            const h = handlers[i];
            if (h.method !== 'ALL' && method !== h.method) continue;
            const { pattern } = h;
            if (!patternMatched(pattern, path)) continue;
            // 评分：字符串路由用段数；正则路由统一给 1 段，避免吃掉所有更具体的字符串路由。
            // 同分时方法精确（非 ALL）优先；再同分时取靠后注册的（保留原行为）。
            const score = typeof pattern === 'string'
                ? pattern.split('/').length
                : 1;
            if (score > bestScore) {
                handler = h;
                bestScore = score;
                continue;
            }
            if (score === bestScore && handler) {
                if (handler.method === 'ALL' && h.method !== 'ALL') {
                    handler = h;
                }
            }
        }

        if (handler) {
            req.params = extractPathParams(handler.pattern, path) || {};
            req.route = { path: handler.pattern };
            const cb = handler.callback;
            try {
                if (cb.constructor.name === 'AsyncFunction') {
                    await cb(req, res, () => {});
                } else {
                    cb(req, res, () => {});
                }
            } catch (err) {
                // 已经响应过就不能再 setStatus；上层 try 会兜底为 500
                throw err;
            }
        }
        // 无匹配由外层 404
    }

    return app;
}

// ---- 工具函数 ----

function patternMatched(pattern, path) {
    if (pattern instanceof RegExp && pattern.test(path)) {
        return true;
    } else {
        if (pattern === '/') return true;
        if (pattern.indexOf(':') === -1) {
            const spath = path.split('/');
            const spattern = pattern.split('/');
            for (let i = 0; i < spattern.length; i++) {
                if (spath[i] !== spattern[i]) {
                    return false;
                }
            }
            return true;
        } else if (extractPathParams(pattern, path)) {
            return true;
        }
    }
    return false;
}

function extractPathParams(pattern, path) {
    if (typeof pattern !== 'string' || pattern.indexOf(':') === -1) {
        return null;
    }
    const params = {};
    for (let i = 0, j = 0; i < pattern.length; i++, j++) {
        if (pattern[i] === ':') {
            let key = [];
            let val = [];
            while (pattern[++i] !== '/' && i < pattern.length) {
                key.push(pattern[i]);
            }
            while (path[j] !== '/' && j < path.length) {
                val.push(path[j++]);
            }
            const rawVal = val.join('');
            // 安全 decode：遇到非法 %xx 序列时，原样返回。
            // 避免一个客户端构造的坏链接把整个服务打挂。
            let decoded;
            try {
                decoded = decodeURIComponent(rawVal);
            } catch (e) {
                decoded = rawVal;
            }
            params[key.join('')] = decoded;
        } else {
            if (pattern[i] !== path[j]) {
                return null;
            }
        }
    }
    return params;
}
