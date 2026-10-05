package upstream

import (
	"bytes"
	"crypto/aes"
	"encoding/base64"
	"math"
	"testing"
)

// 真实向量：上游对 lineId=775200849296 的 cryptoSign。
func TestCryptoSign(t *testing.T) {
	got, err := cryptoSign(map[string]any{"lineId": "775200849296"})
	if err != nil {
		t.Fatal(err)
	}
	const want = "3f2031d13050245b1d39d5e90a824eca"
	if got != want {
		t.Fatalf("cryptoSign = %s, want %s", got, want)
	}
}

// ECB + PKCS7 往返：自己加密再解，验证块循环与去填充。
func TestDecryptECBRoundTrip(t *testing.T) {
	want := []byte(`{"lineId":"775200849296","buses":[]}`)
	got, err := decryptECB(encryptECB(t, want))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("往返不一致: got %q want %q", got, want)
	}
}

func TestDecryptECBRejectsGarbage(t *testing.T) {
	if _, err := decryptECB("not-base64!!"); err == nil {
		t.Fatal("坏 base64 应当报错")
	}
	if _, err := decryptECB(base64.StdEncoding.EncodeToString([]byte("short"))); err == nil {
		t.Fatal("非块对齐的密文应当报错")
	}
}

// 车辆在两站之间的插值比例。车与站同为 WGS 基准。
func TestSegPos(t *testing.T) {
	a := wireStop{Order: 1, WgsLat: 22.60, WgsLng: 110.15}
	b := wireStop{Order: 2, WgsLat: 22.61, WgsLng: 110.15}
	mid := (a.WgsLat + b.WgsLat) / 2

	cases := []struct {
		name     string
		lat, lng float64
		p, q     wireStop
		want     float64
		ok       bool
	}{
		{"在起点站", a.WgsLat, a.WgsLng, a, b, 0, true},
		{"在终点站", b.WgsLat, b.WgsLng, a, b, 1, true},
		{"正中", mid, a.WgsLng, a, b, 0.5, true},
		{"越过终点夹到 1", b.WgsLat + 0.1, b.WgsLng, a, b, 1, true},
		{"退回起点前夹到 0", a.WgsLat - 0.1, a.WgsLng, a, b, 0, true},
		{"站缺坐标 → 不可用", mid, a.WgsLng, a, wireStop{Order: 3}, 0, false},
		{"车缺坐标 → 不可用", 0, 0, a, b, 0, false},
	}
	for _, c := range cases {
		got, ok := segPos(c.lat, c.lng, c.p, c.q)
		if ok != c.ok || (ok && math.Abs(got-c.want) > 1e-6) {
			t.Errorf("%s: segPos = (%v,%v), want (%v,%v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

func encryptECB(t *testing.T, plain []byte) string {
	t.Helper()
	block, err := aes.NewCipher([]byte(aesKey))
	if err != nil {
		t.Fatal(err)
	}
	n := aes.BlockSize - len(plain)%aes.BlockSize
	padded := append(append([]byte{}, plain...), bytes.Repeat([]byte{byte(n)}, n)...)
	out := make([]byte, len(padded))
	for i := 0; i < len(padded); i += aes.BlockSize {
		block.Encrypt(out[i:], padded[i:])
	}
	return base64.StdEncoding.EncodeToString(out)
}
