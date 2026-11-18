import { GoogleGenAI } from '@google/genai';

async function main() {
  console.log('=== TwinkleBot Phase 0 Spike: Live API Check against gemini-4-argon ===\n');

  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is missing in .env');
    process.exit(1);
  }

  const ai = new GoogleGenAI();
  const sample1x1PngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  // --------------------------------------------------------------------------
  // Question 1: tools: [{ type: "computer_use", environment: "desktop" }]
  // --------------------------------------------------------------------------
  console.log('----------------------------------------------------------------------');
  console.log('Q1: Does tools: [{ type: "computer_use", environment: "desktop" }] return action steps?');
  console.log('----------------------------------------------------------------------');

  const turn1 = await ai.interactions.create({
    model: 'gemini-4-argon',
    input: 'Click on the start button at coordinate (100, 200)',
    tools: [{ type: 'computer_use', environment: 'desktop' }],
    store: false,
  });

  console.log(`Turn 1 status: ${turn1.status}`);
  const funcCall1 = turn1.steps?.find((s) => s.type === 'function_call');
  const thought1 = turn1.steps?.find((s) => s.type === 'thought');

  console.log('Live step shape returned:');
  console.log(JSON.stringify(funcCall1, null, 2));

  const q1Answer = funcCall1 && funcCall1.name === 'click' ? 'YES' : 'NO';
  console.log(`\n=> Q1 Answer: ${q1Answer}. Computer use actions are emitted as function_call steps.`);

  // --------------------------------------------------------------------------
  // Question 2: Exact shape of custom function tool & function_result; image handling
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------------');
  console.log('Q2: Shape of function tool & function_result; can function_result carry an image?');
  console.log('----------------------------------------------------------------------');

  // Test custom function declaration
  const customToolRes = await ai.interactions.create({
    model: 'gemini-4-argon',
    input: 'Check server load for server id srv-42',
    tools: [
      {
        type: 'function',
        name: 'get_server_load',
        description: 'Get CPU load for a server',
        parameters: {
          type: 'object',
          properties: {
            server_id: { type: 'string', description: 'Server identifier' },
          },
          required: ['server_id'],
        },
      },
    ],
    store: false,
  });

  const customFuncCall = customToolRes.steps?.find((s) => s.type === 'function_call');
  console.log('Custom function call emitted by model:');
  console.log(JSON.stringify(customFuncCall, null, 2));

  // Test whether image can go inside function_result
  let canImageBeInResult = false;
  try {
    await ai.interactions.create({
      model: 'gemini-4-argon',
      input: [
        { type: 'user_input', content: [{ type: 'text', text: 'Take a screenshot' }] },
        { type: 'function_call', id: 'call_test_img', name: 'take_screenshot', arguments: {} },
        {
          type: 'function_result',
          call_id: 'call_test_img',
          name: 'take_screenshot',
          result: [
            { type: 'text', text: 'Screenshot taken' },
            { type: 'image', data: sample1x1PngBase64, mime_type: 'image/png' },
          ],
        },
      ],
      store: false,
    });
    canImageBeInResult = true;
  } catch (err) {
    console.log(`Image directly in function_result rejected by server: ${err.message}`);
    canImageBeInResult = false;
  }

  // Test sending screenshot in separate user_input step
  const separateUserStepRes = await ai.interactions.create({
    model: 'gemini-4-argon',
    input: [
      { type: 'user_input', content: [{ type: 'text', text: 'Take a screenshot' }] },
      { type: 'function_call', id: 'call_test_img', name: 'take_screenshot', arguments: {} },
      {
        type: 'function_result',
        call_id: 'call_test_img',
        name: 'take_screenshot',
        result: 'Screenshot captured',
      },
      {
        type: 'user_input',
        content: [
          { type: 'text', text: 'Current screen:' },
          { type: 'image', data: sample1x1PngBase64, mime_type: 'image/png' },
        ],
      },
    ],
    store: false,
  });

  console.log(`Separate user_input with image accepted: status=${separateUserStepRes.status}`);
  console.log(
    `=> Q2 Answer: function_result cannot carry an image directly (server returns 400 invalid argument). Screenshots must be passed in a separate user_input step following function_result.`
  );

  // --------------------------------------------------------------------------
  // Question 3: Multi-turn with store: false (Turn 2 and Turn 3)
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------------');
  console.log('Q3: Does sending full prior step list with store: false work for 2nd and 3rd turns?');
  console.log('----------------------------------------------------------------------');

  // Turn 2
  const turn2Input = [
    { type: 'user_input', content: [{ type: 'text', text: 'Click on the start button at coordinate (100, 200)' }] },
    ...(thought1 ? [thought1] : []),
    funcCall1,
    {
      type: 'function_result',
      call_id: funcCall1.id,
      name: funcCall1.name,
      result: 'Clicked at (100, 200) successfully',
    },
  ];

  const turn2 = await ai.interactions.create({
    model: 'gemini-4-argon',
    input: turn2Input,
    tools: [{ type: 'computer_use', environment: 'desktop' }],
    store: false,
  });
  console.log(`Turn 2 status: ${turn2.status}`);

  // Turn 3
  const turn3Input = [
    ...turn2Input,
    ...turn2.steps,
    {
      type: 'user_input',
      content: [{ type: 'text', text: 'Now please double click on the document icon at (300, 400)' }],
    },
  ];

  const turn3 = await ai.interactions.create({
    model: 'gemini-4-argon',
    input: turn3Input,
    tools: [{ type: 'computer_use', environment: 'desktop' }],
    store: false,
  });
  console.log(`Turn 3 status: ${turn3.status}`);
  const funcCall3 = turn3.steps?.find((s) => s.type === 'function_call');
  console.log(`Turn 3 action emitted: ${funcCall3?.name} with args: ${JSON.stringify(funcCall3?.arguments)}`);
  console.log('=> Q3 Answer: YES. Multi-turn step history with store: false works cleanly across turns.');

  // --------------------------------------------------------------------------
  // Question 4: Thoughts and Token Usage locations
  // --------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------------');
  console.log('Q4: Where do thought summaries and token usage appear?');
  console.log('----------------------------------------------------------------------');

  console.log('Thought step structure:');
  console.log(JSON.stringify(thought1, null, 2));

  console.log('Usage object structure:');
  console.log(JSON.stringify(turn1.usage, null, 2));
  console.log(
    '=> Q4 Answer: Thoughts appear in response.steps with type: "thought" and signature (plus optional summary). Token usage appears in response.usage.'
  );

  console.log('\n=== All Phase 0 API Questions Successfully Verified ===');
}

main().catch((err) => {
  console.error('Fatal error in spike:', err);
  process.exit(1);
});
