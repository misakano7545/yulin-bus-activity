package main

import (
	"bytes"
	"crypto/aes"
	"encoding/base64"
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

func TestFleetNo(t *testing.T) {
	plateMap = map[string]string{"桂K12685D": "551"}
	cases := []struct {
		licence, want string
		conf          bool
	}{
		{"433", "433", true},            // 纯数字 = 自编号
		{"桂K12685D", "551", true},       // 已知车牌
		{"桂K99999D", "桂K99999D", false}, // 未知车牌：原样透出并标低可信
	}
	for _, c := range cases {
		got, conf := fleetNo(c.licence)
		if got != c.want || conf != c.conf {
			t.Errorf("fleetNo(%q) = (%q,%v), want (%q,%v)", c.licence, got, conf, c.want, c.conf)
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
