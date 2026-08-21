/**
 * 启动画面：全屏遮罩，只显示 "Made by xxccdl" 文字。
 * 纯 SVG 实现：文字按屏幕中心坐标精确居中（x=W/2, textAnchor=middle，
 * baseline 略偏下使字形居中），一条渐变光带被 ClipPath 裁剪成文字形状，
 * 循环扫过时只有文字笔画内发光 —— DeepSeek Harness 原版思考的流光效果。
 * 常驻直到服务就绪后由 App 切换掉。
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, View } from 'react-native';
import Svg, {
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Rect,
  Stop,
  Text as SvgText,
  TSpan,
} from 'react-native-svg';

const { width: W, height: H } = Dimensions.get('window');
const BAR_W = 280;
const AnimatedRect = Animated.createAnimatedComponent(Rect);

// 文字基线：水平取屏幕正中；垂直 baseline 略低于几何中心，使字形主体居中
const BASELINE_Y = H / 2 + 10;

/** 文字（同一结构用于显示与 ClipPath，保证裁剪对齐）。 */
const Wordmark = ({ fill }: { fill: string }) => (
  <SvgText x={W / 2} y={BASELINE_Y} textAnchor="middle" fill={fill}>
    <TSpan fontSize={19} fontStyle="italic" fontWeight="300">
      Made by{'  '}
    </TSpan>
    <TSpan fontSize={32} fontWeight="600">
      xxccdl
    </TSpan>
  </SvgText>
);

export default function SplashScreen() {
  // 0→1：光带从左扫到右
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // 组件卸载（进入 dsh 界面）时停止循环，避免原生驱动动画残留空耗
    const anim = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 2400,
        easing: Easing.inOut(Easing.sin),
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [shimmer]);

  const translateX = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [-BAR_W, W],
  });
  const opacity = shimmer.interpolate({
    inputRange: [0, 0.2, 0.5, 0.8, 1],
    outputRange: [0, 0.9, 0.5, 0.9, 0],
  });

  return (
    <View style={styles.root}>
      <Svg width={W} height={H}>
        <Defs>
          {/* 文字本体：静态蓝→浅蓝渐变 */}
          <LinearGradient id="baseGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#b9c6ff" />
            <Stop offset="1" stopColor="#6a7ad6" />
          </LinearGradient>
          {/* 流光：光带自身中间亮、两端透明 */}
          <LinearGradient id="sheenGrad" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="rgba(255,255,255,0)" />
            <Stop offset="0.5" stopColor="rgba(255,255,255,0.95)" />
            <Stop offset="1" stopColor="rgba(255,255,255,0)" />
          </LinearGradient>
          {/* 裁剪：把流光限制在文字形状内 */}
          <ClipPath id="textClip">
            <Wordmark fill="#fff" />
          </ClipPath>
        </Defs>

        {/* 基底文字 */}
        <Wordmark fill="url(#baseGrad)" />

        {/* 流光层：被文字形状裁剪，平移扫过 → 文字发光 */}
        <G clipPath="url(#textClip)">
          <AnimatedRect
            x={0}
            y={0}
            width={BAR_W}
            height={H}
            fill="url(#sheenGrad)"
            opacity={opacity}
            transform={[{ translateX }]}
          />
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
