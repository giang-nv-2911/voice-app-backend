import 'dotenv/config';
declare module 'fastify' {
    interface Session {
        user?: {
            id: string;
            email: string;
            name: string;
            picture: string;
            [key: string]: any;
        };
        oauth_state?: string;
    }
}
//# sourceMappingURL=index.d.ts.map