# Usage

## Mac / Unix

```
./curator path/to/image.iso
```

or

```
cd curator-cli
poetry run curator-cli path/to/image.iso
```

# Installing from source

1. Install Python
2. Install [Poetry for Python](https://python-poetry.org/docs/)
3. Run `git clone --recurse-submodules git@github.com:hiddenpalaceorg/curator.git` to clone together with submodules
4. Run `cd curator-cli && poetry install`
5. Run `./curator` from the `curator` directory (not `curator-cli`)

Note: You might have to initialize git submodules.

# Example

```
$ ./curator 'Sonic 3D Blast (Tech Demo).iso'
```

```xml
<datafile>
  <image name="Sonic 3D (Tech Demo - Oct 08).bin" size="12780768" md5="b9524503fd30bb52b527ce6b3ebb9898" sha1="cc344a2d466c4fc75c588ae584fad449b930170e" sha256="45891ddfa4ae1718889e6d83871df3faa6b4cfe1ea2dd483f051fef1543f65d4">
    <info>
      <system name="saturn" identifier="SEGA SEGASATURN" />
      <header title="GAME TITLE" product_number="999999999" product_version="V1.000" release_date="19941122" maker_id="SEGA ENTERPRISES" device_info="CD-1/1" regions="JUE" />
      <volume identifier="SAMPLE_GAME_TITLE" set_identifier="SAMPLE_GAME_TITLE" creation_date="1996-10-08 16:54:15" modification_date="1996-10-08 16:54:15" />
      <exe filename="/0.BIN" date="1996-10-08 16:30:50" />
      <disc type="cdr" />
    </info>
    <contents>
      <file name="0.BIN" date="1996-10-08 11:30:50" size="328892" md5="0c81ba2a6fe7e7e124b154b84a92c67e" sha1="a44a6497df7ffa7980e75c16e73f20f5867b6c58" sha256="147cf656261ba02dc5a166748a12c017db94290e224092dd339d3434b9d76e25" />
      <file name="ABS.TXT" date="1991-05-27 13:26:08" size="19" md5="80f47f0c30d306758893a8eab31bf6e1" sha1="af91dc02b3d3ef32a0da25276c270cf8a928ec3c" sha256="70a12dffa9f20f869c6e956790f4fdc216557a3df16def4c42a59cce7b4f24da" />
      <file name="BIB.TXT" date="1992-04-14 02:10:56" size="26" md5="a3cb807dc45e6522ff8e27895121d2e1" sha1="431722b49e980afb8dfa9f96fb0b864040d2646e" sha256="a1fc0e64a7f7c92f6f219f531500ef8003f385909f7136bfcb1987d9ee9ed334" />
      <directory name="CDDA" date="1996-10-08 11:54:15" size="2048">
        <file name="WARNING.RED" date="1996-09-05 11:01:08" size="7424" md5="2af08cd4739f09c84920224cc398a35d" sha1="f9be34841dfd1f2295d459a6bae5a33d94e3267f" sha256="0251132bd7d22166fd8bb1546f8f33de4b36aa4abe9b21cd8ce38ee904dbe03b" />
      </directory>
      <file name="CPY.TXT" date="1992-04-14 02:11:00" size="36" md5="de7fb73305852a194005b9512f3ce7d9" sha1="390afefc3f9914b9fdabbe9dd3bbeda72162b737" sha256="b39d2fca3c7e559bf8e7d91e5c3ca1107494291d5563aaef5f8c63cd3a8656b4" />
      <directory name="DATA" date="1996-10-08 11:54:15" size="2048">
        <file name="DATA2.BIN" date="1996-10-08 09:17:02" size="419272" md5="af2f7ec274896efa542426df7aa1bd56" sha1="e78a1bb21e12c390e74b54bde8a6818cd1b8138a" sha256="abeb5f88c885f08f3c8efcfb6cdb32105fab18cdb04c3df4291b9c1110cdeec2" />
        <file name="DATAFILE.BIN" date="1996-10-01 07:29:16" size="32254" md5="46d30823d625106ff87c10a0823cdca4" sha1="45237b35a28025b4cfd9d911786c38fc5e610944" sha256="e7000b03226746f93f64f8202b6eab54675743dee2098137f5d39102534990ea" />
        <file name="RANDOM.BIN" date="1996-08-25 14:59:24" size="16384" md5="01171965fe9522c0dd9569fa583055b2" sha1="92461682cbac2283488eaf93864a7875425d875a" sha256="2ba59c1660e83a8fcb7878063f4c71b33d55203c8f2d330d21b8ca475012c6fe" />
        <file name="VRAM.BIN" date="1996-10-08 07:52:48" size="2676" md5="ff6b1115c1bd48e3cd8848071743b607" sha1="d4c8155f0b2f780e2f9fecee4dd7a4e65fe52b4b" sha256="3a2631ac9ad235ac1d0d7e1dbb833c0c728b38c4accd6fdb7f2ca04845683527" />
      </directory>
      <directory name="FONTS" date="1996-10-08 11:54:15" size="2048">
        <file name="FONT16X8.BIN" date="1996-09-05 11:01:08" size="7424" md5="2af08cd4739f09c84920224cc398a35d" sha1="f9be34841dfd1f2295d459a6bae5a33d94e3267f" sha256="0251132bd7d22166fd8bb1546f8f33de4b36aa4abe9b21cd8ce38ee904dbe03b" />
      </directory>
      <file name="IP.BIN" date="1996-09-27 07:32:06" size="5180" md5="f865238f3f10ef8c5d0b6db60d667e41" sha1="c204e64e9b02a367e4ff296f25603fcfcf74847d" sha256="ded685fa5558152c406b1e31e7ccad0a328513ff9df630af66f7f4b276ca0a00" />
      <directory name="LEV1A" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX1A.BIN" date="1996-10-07 13:59:00" size="484568" md5="97ff1334a1a839281c2d231fb1caca39" sha1="4e7a715c7aeb2f14633697d599b3af89e10a0afa" sha256="d99856877aa25e05bb0b65198e39ca95b67ad526fc54ba048fbd967f37537486" />
        <file name="MAP1A.BIN" date="1996-10-07 13:59:12" size="359276" md5="fbb290e916cab26a7e8fa772e853618c" sha1="9eb23d468ceaf340121d77ef712ed16fa0aed4ab" sha256="e9386a40a4e811175b9386044594e0d8c007c6a41676f8fd6ee4fd5ff1da4c90" />
        <file name="OVL1A.BIN" date="1996-10-08 05:38:32" size="32232" md5="dbd5730a279e0505632cb9d1dc03f84b" sha1="f405dd21e0ee4d215f6311981c33da54404bddf2" sha256="d18ace068b71d1df2c085f86052cdbe1698dab9dae89d3782204bb716b1221cf" />
      </directory>
      <directory name="LEV1B" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX1B.BIN" date="1996-10-04 13:35:50" size="492920" md5="d9fb269192c361a2960bd38310b11ad7" sha1="f2ec64268eee305d82594dfd5318d467d87836b8" sha256="2f159aa6d8175c8a6d534eab2335d31dd380cdac109f3e635ba1e613b738bdc7" />
        <file name="MAP1B.BIN" date="1996-10-04 13:36:00" size="392698" md5="6f4fc15e0ed467e49d9f4a9343864fbc" sha1="da1bb79b1d3542f2720d4d813e3239c3ca5f4d58" sha256="99e4c7d0f0b8add2957aed4a55661c7d12bfb2d19dff84b52a7fac8c19ca2819" />
        <file name="OVL1B.BIN" date="1996-10-04 13:36:24" size="31078" md5="29ecd0564e00a40e93cbd67d818aa78d" sha1="90c525988d20a382c748866fa989a13000019c73" sha256="a7f65515a1fb037bc7439553c6e3f239ba2396868146214f4e97100e0f51408f" />
      </directory>
      <directory name="LEV2A" date="1996-10-08 11:54:15" size="2048">
        <file name="CHR2A.BIN" date="1996-10-08 09:33:58" size="8192" md5="0261be0ee5e3e9c1f92fdc312db19733" sha1="8d4d3c4b74e2adfde5f1aa44b096aac791d7cbd2" sha256="2796c685bf4b4667550188a657406ecf5899d2e84b770048068d42ab55527b65" />
        <file name="GFX2A.BIN" date="1996-10-08 11:09:00" size="446572" md5="6f69a091c4c0951a3d84aceb5546ff12" sha1="f812068e953f54973067acf616b09577da52726c" sha256="5a8f8410fb764400557331b7336f048dfc3cb458c70471b3353a4249e878dba8" />
        <file name="MAP2A.BIN" date="1996-10-08 11:09:08" size="289436" md5="e8c13d8b7c3389bf9b108c30c0be1dfe" sha1="9df8584ef4e4045e1e054c236b865f18a145b964" sha256="83fe456d1ee993645fda07c03915168896217dd1759ee3ec2f0d3602733f8190" />
        <file name="OVL2A.BIN" date="1996-10-08 11:09:26" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
        <file name="SCR2A.BIN" date="1996-10-08 10:27:14" size="65536" md5="12280f04a32e6aba9772e2c9021b81bd" sha1="c3584872e24e80051b2364d2b78efd7ff928f4d8" sha256="c63905a4820142d1137f28e0e9f652d3f0e8cd42981c406d602543b38515a720" />
      </directory>
      <directory name="LEV2B" date="1996-10-08 11:54:15" size="2048">
        <file name="CHR2B.BIN" date="1996-10-08 09:33:58" size="8192" md5="0261be0ee5e3e9c1f92fdc312db19733" sha1="8d4d3c4b74e2adfde5f1aa44b096aac791d7cbd2" sha256="2796c685bf4b4667550188a657406ecf5899d2e84b770048068d42ab55527b65" />
        <file name="GFX2B.BIN" date="1996-10-08 11:09:46" size="444492" md5="d7f625e781e7c0b6a4c4b3c2c43d7079" sha1="57f50479cfe52b7d500bfc0bbc70c896457cc501" sha256="1c8e390c11559a4f07054da72cde640afeabd961039814e633356ed1868748fe" />
        <file name="MAP2B.BIN" date="1996-10-08 11:09:54" size="294410" md5="894e2193edaaa9d37f63eea4bb2512a0" sha1="1b485bd6e326d76b308e886eaa6d77f71c078da1" sha256="779cb548ec47b11550840f27a55e3941d332954b71b2050b46fa964f112f3e01" />
        <file name="OVL2B.BIN" date="1996-10-08 11:10:12" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
        <file name="SCR2B.BIN" date="1996-10-08 10:27:14" size="65536" md5="12280f04a32e6aba9772e2c9021b81bd" sha1="c3584872e24e80051b2364d2b78efd7ff928f4d8" sha256="c63905a4820142d1137f28e0e9f652d3f0e8cd42981c406d602543b38515a720" />
      </directory>
      <directory name="LEV3A" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX3A.BIN" date="1996-10-08 10:05:38" size="499314" md5="cdcce3af16a52a85453a019fd51892c2" sha1="5153114c9740a6dc63641521d97670ab481b68ab" sha256="7d9254b9b0a5943283ca7517e0af7df79b541a22c64430b1ca0d98c1c201134d" />
        <file name="MAP3A.BIN" date="1996-10-08 10:05:50" size="268154" md5="4f2b50972d308609077447a3b4993dc7" sha1="2d9ee5b0038d552bea33bf8ae7b7289eb4a3d435" sha256="74b2871033721da34a205d6f40f7233a666bd808efcc8a584293c358bdcb51e5" />
        <file name="OVL3A.BIN" date="1996-10-08 10:06:10" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="LEV3B" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX3B.BIN" date="1996-10-08 10:06:30" size="487506" md5="785f269138a501f46f19af13fc9f2503" sha1="88467090dc92ca0e9d98aa5d6b021c7b07439c80" sha256="9dd6587c16feb42ffc70846d72244f6d6a52d74d3f1b107ad185eb9311feaf5b" />
        <file name="MAP3B.BIN" date="1996-10-08 10:06:42" size="238000" md5="22581bbd85e2e8b29a98c52aa07b39e5" sha1="09e3a0476b415e8a84b77bc6905152891faef572" sha256="73a03f0e724d1d960bc373c76c4018248081686ad053836eea7ac7ec305e669c" />
        <file name="OVL3B.BIN" date="1996-10-08 10:07:04" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="LEV5A" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX5A.BIN" date="1996-10-08 10:12:02" size="461840" md5="798791d02f12bfb103e3d760556b19c9" sha1="4623ff48106e245175fa3c343e72b0735997910e" sha256="938bf53ac7a31b8e7723e58572490fec3cedcbd76cc2950d384b52eb2031e5f8" />
        <file name="MAP5A.BIN" date="1996-10-08 10:12:14" size="242002" md5="c7fdfb36f98854cf1bb03671a6d755ed" sha1="0bfe9c99cfd5521500b21f5314712f97afe4258a" sha256="50de893359f9883d09a439ef3b74d19d710a65404ea55563be3289ffd4c88d01" />
        <file name="OVL5A.BIN" date="1996-10-08 10:12:34" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="LEV6A" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX6A.BIN" date="1996-10-08 10:14:30" size="453054" md5="336a3afa249166a8e8aac0c602f71606" sha1="5475fe84b0d7db9d6babb67a549110f95ac04433" sha256="962fc01b1a0cab9b7cf1381f0513bf8880067401098345df7f12fd3879dafe19" />
        <file name="MAP6A.BIN" date="1996-10-08 10:14:40" size="293562" md5="f73c8c6d8e94f733555f778ea1221c01" sha1="96efe616832c60924173d6891e8466100375243c" sha256="d06b279e834e29ecefb0bbad28ec5980ac17eb43dc742b85de0184aca310a2b2" />
        <file name="OVL6A.BIN" date="1996-10-08 10:14:58" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="LEV6B" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX6B.BIN" date="1996-10-08 10:15:14" size="459038" md5="db2b5abfa7e54d118cdd298dcc44b97b" sha1="606b56c176533d2c5d4eb64573df8f7af72e9eca" sha256="cff8e3ee7d5115dc62005105e85c31d8d29f1a3d8115ed309e1075f61aea0767" />
        <file name="MAP6B.BIN" date="1996-10-08 10:15:24" size="256614" md5="1546bb01f57121bd546cf4e842a20f9b" sha1="c1115403bb41c16aafde520fc58af425d5732008" sha256="af829188e3914f9b6aaf64456418c37e543526c7ec686cfd10fd6be7c5a829bc" />
        <file name="OVL6B.BIN" date="1996-10-08 10:15:40" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="LEV7A" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX7A.BIN" date="1996-10-08 10:26:48" size="398170" md5="8d6675d96145bcbe41303133de7fed3d" sha1="8bb3fd2fd82986d2896b5fc31853b59965ffdd94" sha256="326907acd48bd67b69eceefbf41fd9594657d74e761de103df69c3fe30f61159" />
        <file name="MAP7A.BIN" date="1996-10-08 10:26:58" size="182524" md5="ee1ee57954af88baeecfdd1cce4a8a47" sha1="096f5fb33aba36bd0b2b606a9d79520f9bd52cca" sha256="f6b184c49ef0099fdf0b8403096ab63a31156aa347bb29e89c0b66b76ded500b" />
        <file name="OVL7A.BIN" date="1996-10-08 10:27:18" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="LEV7B" date="1996-10-08 11:54:15" size="2048">
        <file name="GFX7B.BIN" date="1996-10-08 10:28:00" size="411418" md5="74c082647650849267316299c90939dc" sha1="a123f497e230d3ccbd0bc4f2e60100de14185f5b" sha256="71f44e2927126336330c3beed210e1eac507bac22ebd7e5e4a09724e55bb39b7" />
        <file name="MAP7B.BIN" date="1996-10-08 10:28:12" size="247492" md5="1c2d53af118ad8c84ba5a1d9ca859b74" sha1="f6d06aab22e1166262929178e58090e483e61a1c" sha256="ee22d1fba416f2570acc83df2c32ec516872a6f878a2043397947f676ea1481d" />
        <file name="OVL7B.BIN" date="1996-10-08 10:28:30" size="26986" md5="55faaa449497cc35fc88292faefdf7ab" sha1="4fd5afa5b6fa695f04aabdff22b8fcf711dcad97" sha256="5d40682b2441b3bcd277178f37a057f04ff76c9584ee72c7f8c8a6d30fb8c733" />
      </directory>
      <directory name="OVLSPRS" date="1996-10-08 11:54:15" size="2048">
        <file name="BRDGESPR.BIN" date="1996-10-07 08:45:34" size="8832" md5="b0dca2b4b09aae4c6a974d85ffd1e8eb" sha1="b4f28c9f47ee4e5aac589d3ef228752e69f6cf6a" sha256="8f108a52373aef2a1f6c4ebe0d707d946642020974b5f034787bc26dc52ffe9e" />
        <file name="BRIDGE.BIN" date="1996-10-07 08:45:14" size="4096" md5="3ee6e9927a1bb2852bdce6d9e2fc45d5" sha1="426020cf1ac3b391779b5ca32fadf9dbe2acab49" sha256="0d2c78852fe2b0f03bb51972fdeb7b312b72a480f9962813b2eaaba157a970db" />
        <file name="FIRST.BIN" date="1996-09-24 12:08:12" size="4736" md5="46e69acc37f2621e4931a956ccfc1125" sha1="d99599e964faa20a141d2ad517d82cacb0cac00e" sha256="7828cb3f53d40cdf02ec8b5262149599e3454e4b1ac7b6ee1bbd40b8190ebd8b" />
        <file name="RAIN.BIN" date="1996-10-08 09:36:16" size="4288" md5="9a7bc69e6cfca99ff5f1c0db5c546799" sha1="9d0054e9681505f8e0a7489775b9f015814a3c6e" sha256="95de45a7eeb91b8b3ab2a7838ed70716cb78ab4d685e24dba63c0af7eeabb719" />
        <file name="WATER.BIN" date="1996-09-11 07:36:48" size="8192" md5="6eb2f0c6a3c46452c21ed6910ddb7a6b" sha1="7bef10102f525d2688d5f4e7aa2f2381c459f764" sha256="3b59630ece5b48b62dc4dc423da781a4c0f6011b64bc7d749de01a74cb2a54e3" />
        <file name="WATRBLOK.BIN" date="1996-10-04 13:05:30" size="15360" md5="6818d140297213166f31d003571995c1" sha1="08f90c1bd6061d4a580632264cbec8f441b9ea9f" sha256="84ebc66c0c7852b48fccda7bf2501dfa3568a84cb05b018fa53a59e545f79ce7" />
      </directory>
      <directory name="PALETTES" date="1996-10-08 11:54:15" size="2048">
        <file name="LEV1A.PAL" date="1996-09-25 12:27:40" size="6144" md5="0b5334020071be1bce3635634fe59fa3" sha1="8c227ac83f99b5809d36ef0b0f71a4a5f10ff992" sha256="3ce22aa439b2a3727b4868b1d02373a1221bcba0c1c4f64ec18c7d12487fe2d0" />
      </directory>
      <directory name="PANEL" date="1996-10-08 11:54:15" size="2048">
        <file name="BOXDATA.BIN" date="1996-09-26 09:53:52" size="36864" md5="09eae90451ffd49f7b00ab7589488d77" sha1="aa9a161a1db6d3bd25d0a30b8de1529f877c7c39" sha256="e10e2aad042efe15551fbfa86963c84341552e32ca118bdb811b7544ffb3a803" />
        <file name="START.BIN" date="1996-09-30 09:56:22" size="47360" md5="2c926f8e72b5e54d3efae99946eccc1f" sha1="f0fdc27d24a18de7c90ba22040ca92f0c56b3fd2" sha256="1a374135cd3c3f57b94856f343ce09f3fbac8ab41c58890c7250674526e949a2" />
      </directory>
      <directory name="PICTURES" date="1996-10-08 11:54:15" size="2048">
        <file name="OPTIONS.PIC" date="1996-09-06 06:17:20" size="143360" md5="55430e86163d810bec585bf9444bfd42" sha1="723a6cea8f8fa157fc2fb8b0ac356945cefa20ce" sha256="a668b5e43d27524318603a930569624def4f0c178fea37a91d177aad0a2cebfe" />
        <file name="TITLE.PIC" date="1996-09-06 06:18:02" size="143360" md5="c64f033ad4669fa0f9867e7d98dd8ecf" sha1="055fc236c1978a425fddd3d0bbcc77b355534b21" sha256="8c23e69546b1689d081427c56c4c8980d61aaaa6da430aced3467382b298df3c" />
      </directory>
      <file name="SONIC.SCR" date="1996-10-08 11:54:04" size="7429" md5="212a7301c6a83216b7fd348a41fb50f2" sha1="4a8903b0e58eb4226bfdc9204c4eb79e6bd4e303" sha256="b9095736b22ee0eeb1e1574f102b8bdcb0ca483171608a8b2f1f6adff64e0f15" />
      <directory name="SOUND" date="1996-10-08 11:54:15" size="2048">
        <file name="MAP.BIN" date="1996-09-05 08:26:52" size="16" md5="da55fcb97e40eda66121725a0bcb7baa" sha1="7ca56e6869c71a637913efbf807746fddc6b5e52" sha256="09faf993dfd75407290d54b498b71cb77917a177bfbb03b2ac2024bc6cf63c5c" />
        <file name="SDDRVS.BIN" date="1996-09-05 08:26:58" size="25568" md5="3243cfc07e07971b5557dc8b91c31c05" sha1="574ad212da55ce29b380d23c00916f38c7f432cb" sha256="ba769b8080969ae333582599e0027839f2545da4eba49b30d6577780a54b1455" />
        <file name="TONE.BIN" date="1996-09-05 08:27:34" size="225840" md5="ecd5c9736daee65603718cfd124e2139" sha1="1308fb9fbe324d6b6e74ef5e0e4546fd354e9604" sha256="b4d2a8715e894c1bd3553880de8abbd2b0035238515ff936c7cebb9d30f8ec4a" />
      </directory>
    </contents>
  </image>
</datafile>
```

# Contributors

<table>
<tr><td align="center"><a href="https://github.com/travistyoj"><div style="display: flex"><img src="https://avatars.githubusercontent.com/u/6852708" style="height: 40px; margin: auto"></div><div style="text-align: center">travistyoj</div></a></td></tr>
</table>
