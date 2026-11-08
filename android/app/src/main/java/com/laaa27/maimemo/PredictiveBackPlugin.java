package com.laaa27.maimemo;

import android.os.Build;
import android.window.BackEvent;
import android.window.OnBackAnimationCallback;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 预测性返回手势的原生桥。
 *
 * JS 侧进入子视图（文章库 / 生成页 / 词卡）时调 setEnabled(true)，
 * 这里向系统注册 OnBackInvokedCallback（优先级 DEFAULT，晚于 Capacitor 的
 * AndroidX 回调注册，同优先级后注册者胜出），把手势过程转发给 JS：
 *
 *   started / progress / cancelled —— JS 用来驱动跟手动画
 *   commit                         —— 相当于一次返回键，走 JS 的返回栈
 *
 * 手势提交 / 取消后 JS 会 setEnabled(false) 注销回调，系统随之接管
 * 根层级的返回（保持「连按两次退出」的既有行为）。
 *
 * Android 13 只有单方法回调拿不到进度，直接不注册，走 Capacitor 原路。
 */
@CapacitorPlugin(name = "PredictiveBack")
public class PredictiveBackPlugin extends Plugin {

    private boolean registered = false;
    private OnBackInvokedCallback platformCallback;

    @PluginMethod
    public void setEnabled(final PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("enabled"));
        // 注册/注销必须在 UI 线程；Capacitor 插件方法默认跑在后台线程
        getActivity().runOnUiThread(() -> {
            update(on);
            call.resolve();
        });
    }

    private void update(boolean on) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return;

        OnBackInvokedDispatcher dispatcher = getActivity().getOnBackInvokedDispatcher();
        if (on && !registered) {
            platformCallback = new PredictiveCallback();
            dispatcher.registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, platformCallback);
            registered = true;
        } else if (!on && registered) {
            dispatcher.unregisterOnBackInvokedCallback(platformCallback);
            platformCallback = null;
            registered = false;
        }
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private final class PredictiveCallback implements OnBackAnimationCallback {
        @Override
        public void onBackStarted(BackEvent backEvent) {
            fire("started", backEvent.getProgress());
        }

        @Override
        public void onBackProgressed(BackEvent backEvent) {
            fire("progress", backEvent.getProgress());
        }

        @Override
        public void onBackCancelled() {
            fire("cancelled", 0);
        }

        @Override
        public void onBackInvoked() {
            fire("commit", 1);
        }
    }

    private void fire(String event, float progress) {
        JSObject data = new JSObject();
        data.put("progress", progress);
        notifyListeners(event, data, false);
    }
}
