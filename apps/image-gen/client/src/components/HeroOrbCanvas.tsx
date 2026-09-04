import { useEffect, useRef } from "react";
import {
  Clock,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from "three";

// 3D simplex noise, used to displace the orb's surface into a soft, organic
// pulse instead of a hard geometric spin.
//
// Description : Array and textureless GLSL 2D/3D/4D simplex noise functions.
//      Author : Ian McEwan, Ashima Arts.
//     License : Copyright (C) 2011 Ashima Arts. All rights reserved.
//               Distributed under the MIT License.
//               https://github.com/ashima/webgl-noise
const NOISE_GLSL = `
vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

const VERTEX_SHADER = `
uniform float uTime;
varying vec3 vNormal;
varying vec3 vPos;

${NOISE_GLSL}

void main() {
  vNormal = normalize(normalMatrix * normal);
  float n = snoise(position * 1.5 + uTime * 0.18);
  vec3 displaced = position + normal * n * 0.16;
  vPos = displaced;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
`;

const FRAGMENT_SHADER = `
varying vec3 vNormal;
varying vec3 vPos;
uniform float uTime;

void main() {
  vec3 colorA = vec3(0.145, 0.255, 0.788);
  vec3 colorB = vec3(0.427, 0.647, 0.980);
  vec3 colorC = vec3(0.545, 0.184, 0.878);
  vec3 colorD = vec3(0.078, 0.125, 0.239);

  float mixer = clamp(vPos.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(colorA, colorC, smoothstep(0.0, 0.65, mixer));
  base = mix(base, colorB, 0.3 + 0.3 * sin(uTime * 0.25 + vPos.x * 1.4));
  base = mix(base, colorD, smoothstep(0.6, 1.0, mixer));

  float fresnel = pow(1.0 - clamp(abs(vNormal.z), 0.0, 1.0), 2.4);
  vec3 color = base + fresnel * 0.45;
  float alpha = 0.5 + fresnel * 0.4;
  gl_FragColor = vec4(color, alpha);
}
`;

/**
 * Soft, warm WebGL orb for the hero — an organic noise-displaced sphere with
 * a slow auto-rotation and gentle pointer parallax. Skips mounting entirely
 * under prefers-reduced-motion or when WebGL is unavailable; the CSS gradient
 * blob behind it in LandingPage stays visible either way.
 */
export default function HeroOrbCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return;
    }

    const { width, height } = container.getBoundingClientRect();
    const scene = new Scene();
    const camera = new PerspectiveCamera(
      45,
      width / Math.max(height, 1),
      0.1,
      10
    );
    camera.position.z = 3.3;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const geometry = new IcosahedronGeometry(1.35, 4);
    const material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      side: DoubleSide,
    });
    const mesh = new Mesh(geometry, material);
    const group = new Group();
    group.add(mesh);
    scene.add(group);

    let targetTiltX = 0;
    let targetTiltY = 0;
    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      targetTiltY = x * 0.6;
      targetTiltX = y * 0.4;
    };
    container.addEventListener("pointermove", onPointerMove);

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const { width: nextWidth, height: nextHeight } = entry.contentRect;
      if (nextWidth <= 0 || nextHeight <= 0) return;
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
    });
    resizeObserver.observe(container);

    const clock = new Clock();
    let frameId = 0;
    const animate = () => {
      material.uniforms.uTime.value = clock.getElapsedTime();
      mesh.rotation.y += 0.0025;
      mesh.rotation.x += 0.0009;
      group.rotation.x += (targetTiltX - group.rotation.x) * 0.04;
      group.rotation.y += (targetTiltY - group.rotation.y) * 0.04;
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      ref={containerRef}
    />
  );
}
