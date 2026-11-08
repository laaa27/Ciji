package com.laaa27.maimemo;

import android.os.Build;
import android.window.BackEvent;
import android.window.OnBackAnimationCallback;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 预测性返回手势的原生桥。
 *
 * JS 侧进入子视图（文章库 / 生成页 / 词卡）时调 setEnabled(true)：
 *
 *   Android 14+  注册 OnBackAnimationCallback，手势全程转发
 *                （started/progress/cancelled 驱动跟手动画，commit 相当于返回键）
 *   Android 13   注册单方法 OnBackInvokedCallback，只转发 commit
 *   Android 12-  注册 AndroidX OnBackPressedCallback，只转发 commit
 *
 * Capacitor 自带的返回处理已被关闭（disableBackButtonHandler），
 * 子视图打开时这里就是唯一的返回接管方；setEnabled(false) 注销后，
 * 系统在根层级播预测性「返回主页」动画。
 */
@CapacitorPlugin(name = "PredictiveBack")
public class PredictiveBackPlugin extends Plugin {

    private OnBackInvokedCallback platformCallback;
    private OnBackPressedCallback compatCallback;

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
        unregister();

        if (!on) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            platformCallback = new PredictiveCallback();
            getDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, platformCallback);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            platformCallback = new OnBackInvokedCallback() {
                @Override
                public void onBackInvoked() {
                    fire("commit", 1);
                }
            };
            getDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, platformCallback);
        } else {
            compatCallback = new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    fire("commit", 1);
                }
            };
            getActivity().getOnBackPressedDispatcher().addCallback(
                    getActivity(), compatCallback);
        }
    }

    private void unregister() {
        if (platformCallback != null) {
            getDispatcher().unregisterOnBackInvokedCallback(platformCallback);
            platformCallback = null;
        }
        if (compatCallback != null) {
            compatCallback.remove();
            compatCallback = null;
        }
    }

    private OnBackInvokedDispatcher getDispatcher() {
        return getActivity().getOnBackInvokedDispatcher();
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
