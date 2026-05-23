/** Sub-Store Workers OpenAPI 适配层 */

import { Base64 } from 'js-base64';
import { installConsoleLogCapture } from '@/utils/debug-logs';

// 平台检测
const isQX = false;
const isLoon = false;
const isSurge = false;
const isNode = false;
const isStash = false;
const isShadowRocket = false;
const isEgern = false;
const isLanceX = false;
const isGUIforCores = false;
const isWorker = true;

function isPlainObject(obj) {
    return (
        obj !== null &&
        typeof obj === 'object' &&
        [null, Object.prototype].includes(Object.getPrototypeOf(obj))
    );
}

// Promise.prototype.delay — 注入一次即可，避免每次构造都重新挂载
if (!Promise.prototype.delay) {
    const delay = (t, v) =>
        new Promise(function (resolve) {
            setTimeout(resolve.bind(null, v), t);
        });
    // eslint-disable-next-line no-extend-native
    Promise.prototype.delay = async function (t) {
        const v = await this;
        return await delay(t, v);
    };
}

export class OpenAPI {
    constructor(name = 'untitled', debug = false) {
        this.name = name;
        this.debug = debug;

        this.http = HTTP();
        this.env = ENV();

        this.node = null;

        // 内存缓存
        this.cache = {};
        this.root = {};

        this._kvBinding = null; // set by initFromKV()
        this._dirty = false;
        this._rootDirty = false;
        this._cacheSnapshot = '';
        this._rootSnapshot = '';
    }

    /** 从 KV 初始化 */
    async initFromKV(kvBinding) {
        this._kvBinding = kvBinding;
        this._dirty = false;
        this._rootDirty = false;

        // 加载主缓存
        try {
            const raw = await kvBinding.get(this.name, 'text', { cacheTtl: 60 });
            if (raw) {
                this.cache = JSON.parse(raw);
                if (!isPlainObject(this.cache)) {
                    this.cache = {};
                }
                this._cacheSnapshot = raw;
            } else {
                this.cache = {};
                this._cacheSnapshot = '{}';
            }
        } catch (e) {
            this.error(`Failed to load cache from KV: ${e.message}`);
            this.cache = {};
            this._cacheSnapshot = '{}';
        }

        // 加载根数据
        try {
            const raw = await kvBinding.get('root', 'text', { cacheTtl: 60 });
            if (raw) {
                this.root = JSON.parse(raw);
                if (!isPlainObject(this.root)) {
                    this.root = {};
                }
                this._rootSnapshot = raw;
            } else {
                this.root = {};
                this._rootSnapshot = '{}';
            }
        } catch (e) {
            this.error(`Failed to load root from KV: ${e.message}`);
            this.root = {};
        }

        installConsoleLogCapture(this);
    }

    // 同步初始化（空操作）
    initCache() {
        // 由 initFromKV 处理
    }

    // 回写缓存到 KV
    // 改进点：不再用 _dirty 单标志位（可能被并发清空），改成「序列化结果与上次快照对比」。
    // 这样即使两次 persistCache 串行执行也只会真正写入差异。
    async persistCache() {
        if (!this._kvBinding) return;
        const promises = [];
        try {
            const currentCache = JSON.stringify(this.cache, null, 2);
            if (currentCache !== this._cacheSnapshot) {
                const snapshot = currentCache;
                promises.push(
                    this._kvBinding
                        .put(this.name, currentCache)
                        .then(() => {
                            // 仅在写入成功后更新快照，避免失败后丢失变更标记
                            this._cacheSnapshot = snapshot;
                        }),
                );
            }
            const currentRoot = JSON.stringify(this.root, null, 2);
            if (currentRoot !== this._rootSnapshot) {
                const snapshot = currentRoot;
                promises.push(
                    this._kvBinding
                        .put('root', currentRoot)
                        .then(() => {
                            this._rootSnapshot = snapshot;
                        }),
                );
            }
        } catch (e) {
            this.error(`Failed to serialize cache: ${e.message ?? e}`);
        }
        if (promises.length > 0) {
            await Promise.all(promises);
        }
        // _dirty 留作兼容字段，逻辑上不再依赖它
        this._dirty = false;
        this._rootDirty = false;
    }

    write(data, key) {
        this.log(`SET ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            this.root[key] = data;
            this._rootDirty = true;
        } else {
            this.cache[key] = data;
            this._dirty = true;
        }
        // 请求结束时回写
    }

    read(key) {
        this.log(`READ ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            return this.root[key];
        } else {
            return this.cache[key];
        }
    }

    delete(key) {
        this.log(`DELETE ${key}`);
        if (key.indexOf('#') !== -1) {
            key = key.substr(1);
            delete this.root[key];
            this._rootDirty = true;
        } else {
            delete this.cache[key];
            this._dirty = true;
        }
    }

    // 通知：日志 + HTTP URL 推送（支持 Bark、Pushover 等）
    notify(title, subtitle = '', content = '', options = {}) {
        const openURL = options['open-url'];
        const mediaURL = options['media-url'];
        const content_ =
            content +
            (openURL ? `\n点击跳转: ${openURL}` : '') +
            (mediaURL ? `\n多媒体: ${mediaURL}` : '');
        console.log(`[Notify] ${title}\n${subtitle}\n${content_}`);

        const push = this.workerEnv?.SUB_STORE_PUSH_SERVICE;
        if (push && /^https?:\/\//.test(push)) {
            const url = push
                .replace('[推送标题]', encodeURIComponent(title || 'Sub-Store'))
                .replace('[推送内容]', encodeURIComponent([subtitle, content_].filter(Boolean).join('\n')));
            const pushPromise = fetch(url)
                .then((resp) => {
                    console.log(`[Push Service] URL: ${url}\nRES: ${resp.status}`);
                })
                .catch((e) => {
                    console.log(`[Push Service] URL: ${url}\nERROR: ${e}`);
                });
            // 收集到 pendingPushes，由 ctx.waitUntil 保证完成
            if (!this.pendingPushes) this.pendingPushes = [];
            this.pendingPushes.push(pushPromise);
        }
    }

    log(msg) {
        if (this.debug) console.log(`[${this.name}] LOG: ${msg}`);
    }

    info(msg) {
        console.log(`[${this.name}] INFO: ${msg}`);
    }

    error(msg) {
        console.log(`[${this.name}] ERROR: ${msg}`);
    }

    wait(millisec) {
        return new Promise((resolve) => setTimeout(resolve, millisec));
    }

    done(value = {}) {
        // 空操作
    }
}

export function ENV() {
    return {
        isQX,
        isLoon,
        isSurge,
        isNode,
        isStash,
        isShadowRocket,
        isEgern,
        isLanceX,
        isGUIforCores,
        isWorker,
    };
}

export function HTTP(defaultOptions = { baseURL: '' }) {
    const methods = [
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'HEAD',
        'OPTIONS',
        'PATCH',
    ];
    const URL_REGEX =
        /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

    function send(method, options) {
        options = typeof options === 'string' ? { url: options } : options;
        const baseURL = defaultOptions.baseURL;
        if (baseURL && !URL_REGEX.test(options.url || '')) {
            options.url = baseURL ? baseURL + options.url : options.url;
        }
        options = { ...defaultOptions, ...options };
        const timeout = options.timeout;
        const events = {
            ...{
                onRequest: () => {},
                onResponse: (resp) => resp,
                onTimeout: () => {},
            },
            ...options.events,
        };

        events.onRequest(method, options);

        // 原生 fetch 请求
        const controller = new AbortController();
        const fetchOptions = {
            method: method.toUpperCase(),
            headers: options.headers || {},
            signal: controller.signal,
        };

        if (
            options.body &&
            !['GET', 'HEAD'].includes(method.toUpperCase())
        ) {
            fetchOptions.body =
                typeof options.body === 'string'
                    ? options.body
                    : JSON.stringify(options.body);
        }

        const worker = fetch(options.url, fetchOptions).then(async (resp) => {
            let body;
            if (options.encoding === null) {
                body = await resp.arrayBuffer();
            } else {
                body = await resp.text();
            }
            // 转换响应头
            const headers = {};
            resp.headers.forEach((value, key) => {
                headers[key] = value;
            });
            return {
                statusCode: resp.status,
                headers,
                body,
            };
        });

        let timeoutid;
        const timer = timeout
            ? new Promise((_, reject) => {
                  timeoutid = setTimeout(() => {
                      controller.abort();
                      events.onTimeout();
                      return reject(
                          `${method} URL: ${options.url} exceeds the timeout ${timeout} ms`,
                      );
                  }, timeout);
              })
            : null;

        return (
            timer
                ? Promise.race([timer, worker]).then((res) => {
                      clearTimeout(timeoutid);
                      return res;
                  })
                : worker
        ).then((resp) => events.onResponse(resp));
    }

    const http = {};
    methods.forEach(
        (method) =>
            (http[method.toLowerCase()] = (options) => send(method, options)),
    );
    return http;
}
