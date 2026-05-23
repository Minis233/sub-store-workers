/** Sub-Store Workers 入口 */

import { version as workersVersion } from '../package.json';
import { version as substoreVersion } from '../../Sub-Store/backend/package.json';
const version = `${substoreVersion}(w${workersVersion})`;
import $ from '@/core/app';
import express from '@/vendor/express';
import migrate from '@/utils/migration';

import registerSubscriptionRoutes from '@/restful/subscriptions';
import registerCollectionRoutes from '@/restful/collections';
import registerArtifactRoutes from '@/restful/artifacts';
import registerFileRoutes from '@/restful/file';
import registerTokenRoutes from '@/restful/token';
import registerArchiveRoutes from '@/restful/archives';
import registerModuleRoutes from '@/restful/module';
import registerSyncRoutes from '@/restful/sync';
import registerDownloadRoutes from '@/restful/download';
import registerSettingRoutes from '@/restful/settings';
import registerPreviewRoutes from '@/restful/preview';
import registerSortingRoutes from '@/restful/sort';
import registerMiscRoutes from '@/restful/miscs';
import registerNodeInfoRoutes from '@/restful/node-info';
import registerParserRoutes from '@/restful/parser';
import registerLogRoutes from '@/restful/logs';

import { produceArtifact } from '@/restful/sync';
import { syncToGist } from '@/restful/artifacts';
import { gistBackupAction } from '@/restful/miscs';
import { SETTINGS_KEY, ARTIFACTS_KEY, SUBS_KEY, COLLECTIONS_KEY } from '@/constants';
import { findByName } from '@/utils/database';

// 初始化应用及路由
const $app = express({ substore: $ });

registerCollectionRoutes($app);
registerSubscriptionRoutes($app);
registerDownloadRoutes($app);
registerPreviewRoutes($app);
registerSortingRoutes($app);
registerSettingRoutes($app);
registerArtifactRoutes($app);
registerFileRoutes($app);
registerTokenRoutes($app);
registerArchiveRoutes($app);
registerModuleRoutes($app);
registerSyncRoutes($app);
registerNodeInfoRoutes($app);
registerMiscRoutes($app);
registerParserRoutes($app);
registerLogRoutes($app);

export default {
    // 定时同步
    async scheduled(event, env, ctx) {
        const kvError = validateKVBinding(env);
        if (kvError) {
            console.error(`[Cron] ${kvError.message}`);
            return;
        }
        ctx.waitUntil(cronSyncArtifacts(env));
    },

    async fetch(request, env, ctx) {
        try {
            const kvError = validateKVBinding(env);
            if (kvError) return kvError.response;

            // CORS 预检 — 显式列出方法/头，避免某些客户端拒绝 *
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: {
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD',
                        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization',
                        'Access-Control-Max-Age': '86400',
                    },
                });
            }

            const url = new URL(request.url);
            let pathname = url.pathname;

            // 健康检查：始终公开，不需要 KV 也不需要鉴权
            if (pathname === '/healthz') {
                return new Response(JSON.stringify({
                    status: 'success',
                    data: {
                        ok: true,
                        version,
                        runtime: 'Cloudflare Workers',
                        time: new Date().toISOString(),
                    },
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json;charset=UTF-8',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-store',
                    },
                });
            }

            // 路径前缀鉴权（可选）
            // 配置 SUB_STORE_FRONTEND_BACKEND_PATH = "/你的密码" 后
            // 前端后端地址填: https://xxx.pages.dev/你的密码
            // 管理 API 需要带前缀才能访问；
            // 分享 / 下载链接路径在 /share/* 与 /download/*（不在 /api/* 下），始终公开。
            const rawBackendPath = env.SUB_STORE_FRONTEND_BACKEND_PATH;
            const backendPath = normalizeBackendPath(rawBackendPath);
            if (rawBackendPath && !backendPath) {
                console.error(`[Security] SUB_STORE_FRONTEND_BACKEND_PATH is invalid; must start with "/" and not be empty.`);
                return new Response(JSON.stringify({
                    status: 'failed',
                    message: 'SUB_STORE_FRONTEND_BACKEND_PATH must start with "/"',
                }), {
                    status: 500,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                });
            }
            let stripped = false;
            if (backendPath) {
                if (pathname === backendPath) {
                    return new Response(null, {
                        status: 302,
                        headers: {
                            'Location': new URL(backendPath + '/', request.url).toString(),
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                }
                if (pathname.startsWith(backendPath + '/')) {
                    pathname = pathname.slice(backendPath.length) || '/';
                    stripped = true;
                    const newUrl = new URL(request.url);
                    newUrl.pathname = pathname;
                    // 通过密码前缀访问才注入 share 标记（与上游 be_merge 行为一致）
                    if (pathname.startsWith('/api/')) {
                        newUrl.searchParams.set('share', 'true');
                    }
                    request = new Request(newUrl.toString(), request);
                }
            }
            const isManagementApi = pathname.startsWith('/api/');
            if (backendPath && !stripped && isManagementApi) {
                return new Response(JSON.stringify({ status: 'failed', message: 'Unauthorized: missing path prefix' }), {
                    status: 401,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                });
            }
            const isAuthDisabledManagementApi = !backendPath && isManagementApi;
            if (isAuthDisabledManagementApi) {
                console.warn(`[Security] SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is publicly accessible: ${pathname}`);
            }

            // 注入环境变量
            globalThis.__workerEnv = env;

            // 从 KV 加载数据
            await $.initFromKV(env.SUB_STORE_DATA);
            $.workerEnv = env;

            // 数据迁移
            migrate();

            console.log(`Sub-Store Workers v${version} handling: ${request.method} ${pathname}`);

            // 路由分发
            const response = await $app.handleRequest(request);
            if (isAuthDisabledManagementApi) {
                response.headers.set('X-Sub-Store-Security-Warning', 'SUB_STORE_FRONTEND_BACKEND_PATH is not configured; management API is public');
            }

            // 回写 KV + 确保推送完成
            ctx.waitUntil(Promise.all([
                $.persistCache(),
                ...($.pendingPushes || []),
            ]));
            $.pendingPushes = [];

            return response;
        } catch (e) {
            console.error(`Unhandled error: ${e.message}\n${e.stack}`);
            // 出错也尝试回写
            ctx.waitUntil(Promise.all([
                $.persistCache(),
                ...($.pendingPushes || []),
            ]));
            $.pendingPushes = [];
            return new Response(
                JSON.stringify({
                    status: 'failed',
                    message: 'Internal Server Error',
                }),
                {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                    },
                },
            );
        }
    },
};

function normalizeBackendPath(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '/') return null;
    if (!trimmed.startsWith('/')) return null;
    // 去掉末尾的 /，避免 backendPath="/abc/" 时与 pathname="/abc/api" 拼接出错
    return trimmed.replace(/\/+$/, '') || null;
}

function validateKVBinding(env) {
    if (env?.SUB_STORE_DATA?.get && env?.SUB_STORE_DATA?.put) return null;
    const body = JSON.stringify({
        status: 'failed',
        message: 'Missing KV binding: SUB_STORE_DATA. Please bind a Cloudflare KV namespace named SUB_STORE_DATA before running Sub-Store Workers.',
    });
    return {
        message: 'Missing KV binding: SUB_STORE_DATA',
        response: new Response(body, {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        }),
    };
}

/** 定时同步 artifacts 到 Gist */
async function cronSyncArtifacts(env) {
    try {
        globalThis.__workerEnv = env;
        await $.initFromKV(env.SUB_STORE_DATA);
        $.workerEnv = env;

        console.log(`[Cron] Sub-Store Workers v${version} 开始同步...`);

        const settings = $.read(SETTINGS_KEY);
        if (!settings?.githubUser || !settings?.gistToken) {
            console.log('[Cron] 未配置 GitHub Token，跳过同步');
            return;
        }

        const allArtifacts = $.read(ARTIFACTS_KEY);
        if (!allArtifacts || allArtifacts.length === 0) {
            console.log('[Cron] 无 artifacts，跳过同步');
            return;
        }

        const shouldSync = allArtifacts.some((a) => a.sync);
        if (!shouldSync) {
            console.log('[Cron] 无需同步的配置');
            return;
        }

        // 收集需要同步的订阅名
        const allSubs = $.read(SUBS_KEY);
        const allCols = $.read(COLLECTIONS_KEY);
        const subNames = [];
        let enabledCount = 0;

        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source) {
                enabledCount++;
                if (artifact.type === 'subscription') {
                    const sub = findByName(allSubs, artifact.source);
                    if (sub?.url && !subNames.includes(artifact.source)) {
                        subNames.push(artifact.source);
                    }
                } else if (artifact.type === 'collection') {
                    const col = findByName(allCols, artifact.source);
                    if (col?.subscriptions) {
                        for (const sn of col.subscriptions) {
                            const sub = findByName(allSubs, sn);
                            if (sub?.url && !subNames.includes(sn)) {
                                subNames.push(sn);
                            }
                        }
                    }
                }
            }
        }

        if (enabledCount === 0) {
            console.log('[Cron] 无启用同步的配置');
            return;
        }

        // 预生成订阅缓存
        if (subNames.length > 0) {
            await Promise.all(
                subNames.map(async (name) => {
                    try {
                        await produceArtifact({ type: 'subscription', name, awaitCustomCache: true });
                    } catch (e) { /* 忽略 */ }
                }),
            );
        }

        // 生成所有 artifacts
        const files = {};
        const valid = [];
        const invalid = [];

        await Promise.all(
            allArtifacts.map(async (artifact) => {
                try {
                    if (!artifact.sync || !artifact.source) return;
                    console.log(`[Cron] 正在同步：${artifact.name}...`);

                    const output = await produceArtifact({
                        type: artifact.type,
                        name: artifact.source,
                        platform: artifact.platform,
                        produceOpts: {
                            'include-unsupported-proxy': artifact.includeUnsupportedProxy,
                            useMihomoExternal: artifact.platform === 'SurgeMac',
                            prettyYaml: artifact.prettyYaml,
                        },
                    });

                    files[encodeURIComponent(artifact.name)] = { content: output };
                    valid.push(artifact.name);
                } catch (e) {
                    console.error(`[Cron] 生成 ${artifact.name} 失败: ${e.message ?? e}`);
                    invalid.push(artifact.name);
                }
            }),
        );

        console.log(`[Cron] 成功 ${valid.length} 个，失败 ${invalid.length} 个`);

        if (valid.length === 0) {
            console.error('[Cron] 全部失败，跳过上传');
            return;
        }

        // 上传到 Gist
        const resp = await syncToGist(files);
        const body = JSON.parse(resp.body);

        // 更新 artifact URL
        for (const artifact of allArtifacts) {
            if (artifact.sync && artifact.source && valid.includes(artifact.name)) {
                artifact.updated = new Date().getTime();
                let gistFiles = body.files;
                let isGitLab;
                if (Array.isArray(gistFiles)) {
                    isGitLab = true;
                    gistFiles = Object.fromEntries(gistFiles.map((item) => [item.path, item]));
                }
                const raw_url = gistFiles[encodeURIComponent(artifact.name)]?.raw_url;
                artifact.url = isGitLab ? raw_url : raw_url?.replace(/\/raw\/[^/]*\/(.*)/, '/raw/$1');
            }
        }

        $.write(allArtifacts, ARTIFACTS_KEY);

        // Gist 备份上传
        try {
            console.log('[Cron] 上传 Gist 备份...');
            await gistBackupAction('upload');
            console.log('[Cron] Gist 备份完成');
        } catch (e) {
            console.error(`[Cron] Gist 备份失败: ${e.message ?? e}`);
        }

        await $.persistCache();
        console.log('[Cron] 同步完成');
    } catch (e) {
        console.error(`[Cron] 同步失败: ${e.message ?? e}`);
        // 尝试回写
        try { await $.persistCache(); } catch (_) {}
    }
}
