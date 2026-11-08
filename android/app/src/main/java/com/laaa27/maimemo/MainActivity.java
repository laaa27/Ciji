package com.laaa27.maimemo;

import android.content.Context;
import android.os.Bundle;
import android.view.View;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** 与 @capacitor/preferences 使用的是同一个 SharedPreferences */
    private static final String PREFS = "CapacitorStorage";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须赶在 super.onCreate 之前注册，否则 WebView 起来时插件还不存在
        registerPlugin(AppearancePlugin.class);
        super.onCreate(savedInstanceState);

        // 首帧之前先把系统栏上色。JS 那边的 apply 要等 React 起来才发，
        // 中间这段在深色主题下会露出白色的系统栏，冷启动时很显眼。
        boolean dark = "dark".equals(
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("theme", "light"));
        AppearancePlugin.applyTo(this, getBridge() == null ? null : getBridge().getWebView(), dark);

        // 关掉 WebView 的过卷拉伸（Android 12+ 的系统级 stretch 效果）：
        // 顶/底滚到头继续拖，整个页面会被扯得变形，禁掉后到头就是停住
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setOverScrollMode(View.OVER_SCROLL_NEVER);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 沉浸式手势条：用户上滑临时呼出、或弹过对话框后，重新隐藏
        if (hasFocus) AppearancePlugin.hideNavigationBars(this);
    }
}
