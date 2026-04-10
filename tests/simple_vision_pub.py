"""简单视觉 ZMQ 发布器 — 替代 vision_service，直接用 Pipeline + YuNet"""
import pyorbbecsdk as ob
import cv2, numpy as np, zmq, json, time, sys, signal

running = True
def stop(s, f): global running; running = False
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)

pipe = ob.Pipeline()
config = ob.Config()
cp = pipe.get_stream_profile_list(ob.OBSensorType.COLOR_SENSOR).get_default_video_stream_profile()
config.enable_stream(cp)
dp = pipe.get_stream_profile_list(ob.OBSensorType.DEPTH_SENSOR).get_default_video_stream_profile()
config.enable_stream(dp)
pipe.start(config)
time.sleep(1)

detector = cv2.FaceDetectorYN.create('models/face_detection_yunet.onnx', '', (320, 320), 0.3)

ctx = zmq.Context()
pub = ctx.socket(zmq.PUB)
pub.bind('tcp://127.0.0.1:5555')
time.sleep(0.5)

print("Vision publisher running on tcp://127.0.0.1:5555", flush=True)
frame_count = 0
while running:
    fs = pipe.wait_for_frames(1000)
    if not fs or not fs.get_color_frame():
        continue
    cf = fs.get_color_frame()
    raw = np.frombuffer(cf.get_data(), dtype=np.uint8)
    img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if img is None:
        continue
    h, w = img.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    n = 0 if faces is None else len(faces)

    result = {"faces": [], "presence": n > 0, "confidence": 0.0, "distance_m": None, "is_talking": False, "hands": []}
    if faces is not None:
        for f in faces:
            dist = 2.0
            df = fs.get_depth_frame()
            if df:
                dd = np.frombuffer(df.get_data(), dtype=np.uint16).reshape(df.get_height(), df.get_width())
                cx = int((float(f[0]) + float(f[2]) / 2) / w * df.get_width())
                cy = int((float(f[1]) + float(f[3]) / 2) / h * df.get_height())
                cx, cy = max(0, min(cx, df.get_width() - 1)), max(0, min(cy, df.get_height() - 1))
                d = int(dd[cy, cx])
                if d > 0:
                    dist = d / 1000.0
            result["faces"].append({
                "x": float(f[0] / w), "y": float(f[1] / h), "w": float(f[2] / w), "h": float(f[3] / h),
                "confidence": float(f[-1]), "frontal_percent": 80.0, "distance_m": dist,
            })
            result["confidence"] = float(f[-1])
            result["distance_m"] = dist

    pub.send_string(json.dumps(result))
    frame_count += 1
    if frame_count % 30 == 0 and n > 0:
        print(f"[{frame_count}] faces={n} dist={result.get('distance_m')}m", flush=True)
    time.sleep(0.033)  # ~30fps

pipe.stop()
pub.close()
ctx.term()
print("Vision publisher stopped")
