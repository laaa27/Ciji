/// <reference types="vite/client" />

/** 由 vite.config.ts 在构建时注入，来源是 package.json 的 version */
declare const __APP_VERSION__: string

/** 同上，来源是 android/app/build.gradle 的 versionCode（读不到时是空串） */
declare const __APP_VERSION_CODE__: string
