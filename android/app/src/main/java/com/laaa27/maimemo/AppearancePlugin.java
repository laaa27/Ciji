package com.laaa27.maimemo;

import android.app.Activity;
import android.graphics.Color;
import android.view.Window;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 让系统栏跟着 App 的主题走。
 *
 * 为什么自己写而不用 @capacitor/status-bar：
 * 1. 那个插件只管状态栏，**管不到底部导航栏** —— 深色主题下底部会留一条白带
 * 2. 它只改图标明暗（Style），不改系统栏底色。Android 15+ 强制 edge-to-edge、
 *    系统栏透明，看不出问题；但 Android 15 以下（以及不强制 edge-to-edge 的 ROM）
 *    系统栏取的是主题里的浅色，于是「白底 + 浅色图标」= 一条什么都看不见的白带
 *
 * 一次做全：底色、图标明暗、窗口背景、WebView 背景。
 * Android 15+ 上 setStatusBarColor 会被系统忽略（本来就透明覆盖），图标明暗依然生效。
 */
@CapacitorPlugin(name = "Appearance")
public class AppearancePlugin extends Plugin {

    private static final String PAPER_LIGHT = "#F7F8F5";
    private static final String PAPER_DARK = "#121413";

    /** 供 MainActivity 在首帧前调用，避免冷启动先露一眼白 */
    static void applyTo(Activity activity, WebView webView, boolean dark) {
        if (activity == null) return;

        final int color = Color.parseColor(dark ? PAPER_DARK : PAPER_LIGHT);
        Window window = activity.getWindow();

        // 系统栏底色。Android 15+ 上透明覆盖、会被忽略，无副作用；
        // 旧版本上给状态栏兜个底色（导航条已隐藏，颜色无所谓）。
        // 手势区（小白条）由 hideNavigationBars 直接隐藏，见下。
        window.setStatusBarColor(color);
        window.setNavigationBarColor(color);

        // 图标明暗：浅色背景要深色图标，深色背景要浅色图标
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
        }

        // 窗口与 WebView 的底：切换主题、重绘的瞬间不会露出上一种底色
        window.getDecorView().setBackgroundColor(color);
        if (webView != null) {
            webView.setBackgroundColor(color);
        }
    }

    @PluginMethod
    public void apply(PluginCall call) {
        Boolean requested = call.getBoolean("dark", false);
        final boolean dark = Boolean.TRUE.equals(requested);

        if (getActivity() == null) {
            call.resolve();
            return;
        }

        getActivity().runOnUiThread(() -> applyTo(getActivity(), getBridge() == null ? null : getBridge().getWebView(), dark));
        call.resolve();
    }
}
