"""
Fish scanning logic.

Adapted from david-svitov/fishscanner (engine/simplescanner.py).
Original approach: the user prints a pattern sheet with 4 ArUco markers,
draws a fish inside the frame, and photographs it. The scanner finds the
4 markers, perspective-corrects the photo, then removes the white
background by thresholding.

For a phone-camera flow we keep that behaviour (best quality, works even
if the photo is taken at an angle) but add a fallback: if no markers are
found, we just treat the whole photo as the drawing and remove the
(assumed white/light) background directly, so the app still works with a
quick photo of a fish drawn on plain paper without printing the pattern.
"""
import cv2
import numpy as np


class FishScanner:
    """
    Scanner that turns a photo of a hand-drawn fish into a transparent PNG.
    """

    def __init__(self):
        self._aruco_dict = cv2.aruco.Dictionary_get(cv2.aruco.DICT_4X4_50)
        self._aruco_params = cv2.aruco.DetectorParameters_create()

        self._marker_top_left_id = 3
        self._marker_top_right_id = 1
        self._marker_bottom_left_id = 4
        self._marker_bottom_right_id = 2

        # Target size of scanned image in pixels
        self.target_w = 800
        self.target_h = 600

    def _find_markers_and_warp(self, frame: np.ndarray) -> np.ndarray:
        """
        Try to find the 4 ArUco markers of the printed pattern and
        perspective-correct the photo. Raises ValueError if not found.
        """
        corners, ids, rejected = cv2.aruco.detectMarkers(
            frame, self._aruco_dict, parameters=self._aruco_params
        )

        top_left, top_right, bottom_right, bottom_left = None, None, None, None

        if ids is not None and len(corners) > 0:
            ids = ids.flatten()
            for (marker_corner, marker_id) in zip(corners, ids):
                c = marker_corner.reshape((4, 2))
                if marker_id == self._marker_top_left_id:
                    top_left, _, _, _ = c
                elif marker_id == self._marker_top_right_id:
                    _, top_right, _, _ = c
                elif marker_id == self._marker_bottom_right_id:
                    _, _, bottom_right, _ = c
                elif marker_id == self._marker_bottom_left_id:
                    _, _, _, bottom_left = c

        if (top_left is None) or (top_right is None) or (bottom_right is None) or (bottom_left is None):
            raise ValueError("Markers not found")

        tr = (int(top_right[0]), int(top_right[1]))
        br = (int(bottom_right[0]), int(bottom_right[1]))
        bl = (int(bottom_left[0]), int(bottom_left[1]))
        tl = (int(top_left[0]), int(top_left[1]))

        width_a = np.sqrt(((br[0] - bl[0]) ** 2) + ((br[1] - bl[1]) ** 2))
        width_b = np.sqrt(((tr[0] - tl[0]) ** 2) + ((tr[1] - tl[1]) ** 2))
        max_width = max(int(width_a), int(width_b))

        height_a = np.sqrt(((tr[0] - br[0]) ** 2) + ((tr[1] - br[1]) ** 2))
        height_b = np.sqrt(((tl[0] - bl[0]) ** 2) + ((tl[1] - bl[1]) ** 2))
        max_height = max(int(height_a), int(height_b))

        dst = np.array([
            [0, 0],
            [max_width - 1, 0],
            [max_width - 1, max_height - 1],
            [0, max_height - 1]], dtype="float32")

        rect = np.array((tl, tr, br, bl)).astype("float32")
        matrix = cv2.getPerspectiveTransform(rect, dst)
        warped = cv2.warpPerspective(frame, matrix, (max_width, max_height))
        return warped

    def _remove_background(self, frame: np.ndarray, cut_marker_corners: bool) -> np.ndarray:
        frame = cv2.resize(frame, (self.target_w, self.target_h))
        frame = cv2.convertScaleAbs(frame, alpha=1.2, beta=10)

        gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        _, mask = cv2.threshold(gray, 130, 255, cv2.THRESH_BINARY)
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        if cut_marker_corners:
            marker_size = 130
            mask = cv2.rectangle(mask, (0, 0), (marker_size, marker_size), 255, -1)
            mask = cv2.rectangle(mask, (self.target_w - marker_size, 0),
                                  (self.target_w, marker_size), 255, -1)
            mask = cv2.rectangle(mask, (self.target_w - marker_size, self.target_h - marker_size),
                                  (self.target_w, self.target_h), 255, -1)
            mask = cv2.rectangle(mask, (0, self.target_h - marker_size),
                                  (marker_size, self.target_h), 255, -1)

        mask_filled = mask.copy()
        cv2.floodFill(mask_filled, np.zeros((self.target_h + 2, self.target_w + 2), np.uint8), (0, 0), 0)
        mask_filled += 255 - mask

        filtered_frame = cv2.cvtColor(frame, cv2.COLOR_RGB2RGBA)
        filtered_frame[..., 3] = mask_filled
        return filtered_frame

    @staticmethod
    def _crop_to_content(frame_rgba: np.ndarray) -> np.ndarray:
        """Crop the transparent canvas down to the fish's bounding box."""
        alpha = frame_rgba[..., 3]
        ys, xs = np.where(alpha > 10)
        if len(xs) == 0 or len(ys) == 0:
            return frame_rgba
        pad = 6
        x0, x1 = max(0, xs.min() - pad), min(frame_rgba.shape[1], xs.max() + pad)
        y0, y1 = max(0, ys.min() - pad), min(frame_rgba.shape[0], ys.max() + pad)
        return frame_rgba[y0:y1, x0:x1]

    def scan(self, frame_bgr: np.ndarray) -> np.ndarray:
        """
        Full pipeline: BGR photo (as read by cv2.imread / decoded upload) ->
        RGBA image of just the fish, background removed, cropped to content.
        """
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

        try:
            warped = self._find_markers_and_warp(frame_rgb)
            result = self._remove_background(warped, cut_marker_corners=True)
        except ValueError:
            # Fallback: no printed pattern found, use whole photo
            result = self._remove_background(frame_rgb, cut_marker_corners=False)

        return self._crop_to_content(result)
